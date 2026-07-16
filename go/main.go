package main
import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// ─── Config ─────────────────────────────────────────────────────────────────

type Config struct {
	Upstream       string        `json:"upstream"`
	CooldownMs     int64         `json:"cooldownMs"`
	MaxCooldownMs  int64         `json:"maxCooldownMs"`
	KeylessEnabled bool
	Keys           []KeyConfig   `json:"keys"`
}

type KeyConfig struct {
	ID     string `json:"id"`
	APIKey string `json:"apiKey"`
	Enabled bool  `json:"enabled"`
}

type KeysFile struct {
	Version  int          `json:"version"`
	Upstream string       `json:"upstream"`
	Cooldown struct {
		BaseMs int64 `json:"baseMs"`
		MaxMs  int64 `json:"maxMs"`
	} `json:"cooldown"`
	Keys []KeyConfig `json:"keys"`
}

func loadConfig() Config {
	configPath := os.Getenv("FIRECRAWL_KEYS_FILE")
	if configPath == "" {
		exe, _ := os.Executable()
		configPath = filepath.Join(filepath.Dir(exe), "firecrawl-keys.json")
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		fatal("read config: %v", err)
	}

	var kf KeysFile
	if err := json.Unmarshal(data, &kf); err != nil {
		fatal("parse config: %v", err)
	}

	if len(kf.Keys) == 0 {
		fatal("no keys in %s", configPath)
	}

	cooldown := kf.Cooldown.BaseMs
	if cooldown == 0 {
		cooldown = 900_000
	}
	maxCooldown := kf.Cooldown.MaxMs
	if maxCooldown == 0 {
		maxCooldown = 21_600_000
	}

	upstream := kf.Upstream
	if upstream == "" {
		upstream = "https://api.firecrawl.dev"
	}

	return Config{
		Upstream:       upstream,
		CooldownMs:     cooldown,
		MaxCooldownMs:  maxCooldown,
		KeylessEnabled: os.Getenv("FIRECRAWL_NO_KEYLESS") != "1",
		Keys:           kf.Keys,
	}
}

// ─── Key Pool ───────────────────────────────────────────────────────────────

type PoolKey struct {
	ID               string
	APIKey           string
	Enabled          bool
	Credits          int64
	BlockedUntil     time.Time
	Consecutive402s  int
	mu               sync.Mutex
}

type KeyPool struct {
	keys          []*PoolKey
	cooldownMs    int64
	maxCooldownMs int64
}

func NewKeyPool(keys []KeyConfig, cooldownMs, maxCooldownMs int64) *KeyPool {
	pool := &KeyPool{
		cooldownMs:    cooldownMs,
		maxCooldownMs: maxCooldownMs,
	}
	for _, k := range keys {
		pool.keys = append(pool.keys, &PoolKey{
			ID:      k.ID,
			APIKey:  k.APIKey,
			Enabled: k.Enabled,
			Credits: -1, // unknown
		})
	}
	return pool
}

func (p *KeyPool) Acquire(exclude map[string]bool) *PoolKey {
	now := time.Now()
	var eligible []*PoolKey

	for _, k := range p.keys {
		k.mu.Lock()
		if k.Enabled && k.BlockedUntil.Before(now) && !exclude[k.ID] {
			eligible = append(eligible, k)
		}
		k.mu.Unlock()
	}

	if len(eligible) == 0 {
		return nil
	}

	// Credit-aware: route to key with most remaining credits
	sort.Slice(eligible, func(i, j int) bool {
		return eligible[i].Credits > eligible[j].Credits
	})

	return eligible[0]
}

func (p *KeyPool) Mark402(key *PoolKey) {
	key.mu.Lock()
	defer key.mu.Unlock()

	key.Consecutive402s++
	key.Credits = 0
	cooldown := p.cooldownMs
	for i := int64(1); i < int64(key.Consecutive402s); i++ {
		cooldown *= 2
		if cooldown > p.maxCooldownMs {
			cooldown = p.maxCooldownMs
			break
		}
	}
	key.BlockedUntil = time.Now().Add(time.Duration(cooldown) * time.Millisecond)
	log("Key %s blocked %ds (402 #%d)", key.ID, cooldown/1000, key.Consecutive402s)
}

func (p *KeyPool) MarkSuccess(key *PoolKey) {
	key.mu.Lock()
	defer key.mu.Unlock()
	key.Consecutive402s = 0
	key.BlockedUntil = time.Time{}
}

func (p *KeyPool) AllBlocked() bool {
	now := time.Now()
	for _, k := range p.keys {
		k.mu.Lock()
		blocked := !k.Enabled || k.BlockedUntil.After(now)
		k.mu.Unlock()
		if !blocked {
			return false
		}
	}
	return true
}

func (p *KeyPool) NextRetryAt() *time.Time {
	var earliest *time.Time
	now := time.Now()
	for _, k := range p.keys {
		k.mu.Lock()
		if k.BlockedUntil.After(now) {
			if earliest == nil || k.BlockedUntil.Before(*earliest) {
				t := k.BlockedUntil
				earliest = &t
			}
		}
		k.mu.Unlock()
	}
	return earliest
}

// ─── Tool Routes ────────────────────────────────────────────────────────────

type Route struct {
	Path    string
	Method  string
	IDInURL bool
	SubPath string
}

var toolRoutes = map[string]Route{
	"firecrawl_scrape":              {Path: "/v2/scrape", Method: "POST"},
	"firecrawl_search":              {Path: "/v2/search", Method: "POST"},
	"firecrawl_map":                 {Path: "/v2/map", Method: "POST"},
	"firecrawl_crawl":               {Path: "/v2/crawl", Method: "POST"},
	"firecrawl_check_crawl_status":  {Path: "/v2/crawl", Method: "GET", IDInURL: true},
	"firecrawl_extract":             {Path: "/v2/extract", Method: "POST"},
	"firecrawl_parse":               {Path: "/v2/parse", Method: "POST"},
	"firecrawl_interact":            {Path: "/v2/interact", Method: "POST"},
	"firecrawl_interact_stop":       {Path: "/v2/interact", Method: "POST"},
	"firecrawl_agent":               {Path: "/v2/agent", Method: "POST"},
	"firecrawl_agent_status":        {Path: "/v2/agent", Method: "GET", IDInURL: true},
	"firecrawl_search_feedback":     {Path: "/v2/search/feedback", Method: "POST"},
	"firecrawl_feedback":            {Path: "/v2/feedback", Method: "POST"},
	"firecrawl_monitor_create":      {Path: "/v2/monitors", Method: "POST"},
	"firecrawl_monitor_list":        {Path: "/v2/monitors", Method: "GET"},
	"firecrawl_monitor_get":         {Path: "/v2/monitors", Method: "GET", IDInURL: true},
	"firecrawl_monitor_update":      {Path: "/v2/monitors", Method: "PATCH", IDInURL: true},
	"firecrawl_monitor_delete":      {Path: "/v2/monitors", Method: "DELETE", IDInURL: true},
	"firecrawl_monitor_run":         {Path: "/v2/monitors", Method: "POST", IDInURL: true, SubPath: "/run"},
	"firecrawl_monitor_checks":      {Path: "/v2/monitors", Method: "GET", IDInURL: true, SubPath: "/checks"},
	"firecrawl_monitor_check":       {Path: "/v2/monitors", Method: "GET", IDInURL: true, SubPath: "/checks"},
	"firecrawl_research_search_papers":  {Path: "/v2/research/search/papers", Method: "POST"},
	"firecrawl_research_inspect_paper":  {Path: "/v2/research/inspect/paper", Method: "POST"},
	"firecrawl_research_related_papers": {Path: "/v2/research/related/papers", Method: "POST"},
	"firecrawl_research_read_paper":     {Path: "/v2/research/read/paper", Method: "POST"},
	"firecrawl_research_search_github":  {Path: "/v2/research/search/github", Method: "POST"},
}

var keylessSafe = map[string]bool{
	"firecrawl_search":    true,
	"firecrawl_scrape":    true,
	"firecrawl_interact":  true,
}

// ─── HTTP Execution ─────────────────────────────────────────────────────────

var httpClient = &http.Client{Timeout: 60 * time.Second}

func executeRequest(config Config, pool *KeyPool, toolName string, args map[string]any) (any, bool) {
	route, ok := toolRoutes[toolName]
	if !ok {
		return map[string]any{"error": fmt.Sprintf("unknown tool: %s", toolName)}, true
	}

	isKeylessSafe := config.KeylessEnabled && keylessSafe[toolName]

	// Build URL path
	urlPath := route.Path
	if route.IDInURL {
		if id, ok := args["id"].(string); ok {
			urlPath += "/" + id
		}
		if route.SubPath != "" {
			urlPath += route.SubPath
		}
	}

	attempted := make(map[string]bool)

	for {
		key := pool.Acquire(attempted)
		if key == nil {
			// Keyless fallback
			if isKeylessSafe {
				body, _ := json.Marshal(args)
				req, _ := http.NewRequest("POST", config.Upstream+urlPath, bytes.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				resp, err := httpClient.Do(req)
				if err == nil {
					defer resp.Body.Close()
					var result any
					json.NewDecoder(resp.Body).Decode(&result)
					return result, resp.StatusCode >= 400
				}
				log("Keyless failed: %v", err)
			}
			retryAt := pool.NextRetryAt()
			retry := ""
			if retryAt != nil {
				retry = retryAt.Format(time.RFC3339)
			}
			return map[string]any{"error": "All keys exhausted", "nextRetry": retry}, true
		}

		attempted[key.ID] = true

		// Build request
		var req *http.Request
		fullURL := config.Upstream + urlPath

		if route.Method == "GET" {
			req, _ = http.NewRequest("GET", fullURL, nil)
		} else {
			body, _ := json.Marshal(args)
			req, _ = http.NewRequest(route.Method, fullURL, bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
		}

		req.Header.Set("Authorization", "Bearer "+key.APIKey)
		req.Header.Set("x-firecrawl-api-key", key.APIKey)

		resp, err := httpClient.Do(req)
		if err != nil {
			log("Key %s: %v", key.ID, err)
			continue
		}

		if resp.StatusCode == 402 {
			resp.Body.Close()
			pool.Mark402(key)
			continue
		}

		pool.MarkSuccess(key)
		var result any
		json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()
		return result, resp.StatusCode >= 400
	}
}

// ─── Credit Checking ────────────────────────────────────────────────────────

func checkCredits(upstream, apiKey string) int64 {
	req, _ := http.NewRequest("GET", upstream+"/v1/team/credit-usage", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("x-firecrawl-api-key", apiKey)

	resp, err := httpClient.Do(req)
	if err != nil {
		return -1
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return -1
	}

	var data struct {
		Data struct {
			RemainingCredits int64 `json:"remaining_credits"`
		} `json:"data"`
	}
	json.NewDecoder(resp.Body).Decode(&data)
	return data.Data.RemainingCredits
}

// ─── MCP Protocol ───────────────────────────────────────────────────────────

type MCPMessage struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      any            `json:"id,omitempty"`
	Method  string         `json:"method,omitempty"`
	Params  map[string]any `json:"params,omitempty"`
}

type MCPResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Result  any    `json:"result,omitempty"`
	Error   any    `json:"error,omitempty"`
}

type MCPCallResult struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      any            `json:"id,omitempty"`
	Result  MCPCallContent `json:"result"`
}

type MCPCallContent struct {
	Content []MCPContentBlock `json:"content"`
	IsError bool              `json:"isError"`
}

type MCPContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type MCPTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func handleMCPMessage(config Config, pool *KeyPool, msg MCPMessage) any {
	switch msg.Method {
	case "initialize":
		return MCPResponse{
			JSONRPC: "2.0",
			ID:      msg.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":   map[string]any{"tools": map[string]any{}},
				"serverInfo":     map[string]any{"name": "firecrawl-mcp-proxy", "version": "2.0.0"},
				"instructions":   "Firecrawl MCP proxy with key pooling.",
			},
		}

	case "notifications/initialized":
		return nil

	case "tools/list":
		var tools []MCPTool
		for name := range toolRoutes {
			tools = append(tools, MCPTool{
				Name:        name,
				Description: fmt.Sprintf("Firecrawl %s", name[10:]),
				InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
			})
		}
		return MCPResponse{
			JSONRPC: "2.0",
			ID:      msg.ID,
			Result:  map[string]any{"tools": tools},
		}

	case "tools/call":
		toolName, _ := msg.Params["name"].(string)
		args, _ := msg.Params["arguments"].(map[string]any)
		if args == nil {
			args = make(map[string]any)
		}
		result, isError := executeRequest(config, pool, toolName, args)
		text, _ := json.MarshalIndent(result, "", "  ")
		return MCPCallResult{
			JSONRPC: "2.0",
			ID:      msg.ID,
			Result: MCPCallContent{
				Content: []MCPContentBlock{{Type: "text", Text: string(text)}},
				IsError: isError,
			},
		}

	default:
		return MCPResponse{
			JSONRPC: "2.0",
			ID:      msg.ID,
			Error:   map[string]any{"code": -32601, "message": fmt.Sprintf("Method not found: %s", msg.Method)},
		}
	}
}


func main() {
	config := loadConfig()
	pool := NewKeyPool(config.Keys, config.CooldownMs, config.MaxCooldownMs)

	log("%d key(s) loaded", len(config.Keys))

	// Probe credits
	var wg sync.WaitGroup
	for i := range pool.keys {
		wg.Add(1)
		go func(key *PoolKey) {
			defer wg.Done()
			credits := checkCredits(config.Upstream, key.APIKey)
			key.mu.Lock()
			key.Credits = credits
			key.mu.Unlock()
		}(pool.keys[i])
	}
	wg.Wait()

	// Log summary
	var parts []string
	var total int64
	for _, k := range pool.keys {
		k.mu.Lock()
		c := k.Credits
		k.mu.Unlock()
		parts = append(parts, fmt.Sprintf("%s:%d", k.ID, c))
		total += c
	}
	log("Credits: %s (total: %d)", join(parts, " | "), total)

	if config.KeylessEnabled {
		log("Keyless fallback enabled")
	}

	// Read stdin line by line
	var asyncWg sync.WaitGroup
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var msg MCPMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}

		response := handleMCPMessage(config, pool, msg)
		if response == nil {
			continue
		}

		// Check if this is a tools/call (async)
		if msg.Method == "tools/call" {
			asyncWg.Add(1)
			go func(m MCPMessage, r any) {
				defer asyncWg.Done()
				data, _ := json.Marshal(r)
				os.Stdout.Write(append(data, '\n'))
			}(msg, response)
		} else {
			data, _ := json.Marshal(response)
			os.Stdout.Write(append(data, '\n'))
		}
	}

	// Wait for all async handlers to complete
	asyncWg.Wait()
}

// ─── Helpers ────────────────────────────────────────────────────────────────

func log(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[firecrawl-pool] "+format+"\n", args...)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[firecrawl-pool] FATAL: "+format+"\n", args...)
	os.Exit(1)
}

func join(parts []string, sep string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += sep
		}
		result += p
	}
	return result
}
