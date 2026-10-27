package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	proxyconfig "github.com/router-for-me/CLIProxyAPI/v7/sdk/config"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

func TestSystemProxyFormats(t *testing.T) {
	for _, test := range []struct{ input, expected string }{
		{"127.0.0.1:7890", "http://127.0.0.1:7890"},
		{"http=127.0.0.1:80;https=127.0.0.1:443;socks=127.0.0.1:1080", "http://127.0.0.1:443"},
		{"https=http://127.0.0.1:8080;http=127.0.0.1:80", "http://127.0.0.1:8080"},
		{"socks=127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"[::1]:7890", "http://[::1]:7890"},
	} {
		actual, err := normalizeSystemProxy(test.input)
		if err != nil || actual != test.expected {
			t.Fatalf("unexpected system proxy normalization for %q", test.input)
		}
	}
	for _, invalid := range []string{"", "direct", "ftp://localhost:21", "http://localhost:8080/private", "http://localhost:8080?secret=password"} {
		if _, err := normalizeSystemProxy(invalid); err == nil {
			t.Fatalf("expected invalid proxy rejection for %q", invalid)
		}
	}
}

func TestProxyPrecedenceAndDisabledSystemProxy(t *testing.T) {
	environment := map[string]string{"HTTPS_PROXY": "http://environment-proxy.example:8080"}
	systemCalled := false
	system := func() (string, bool, error) { systemCalled = true; return "127.0.0.1:7890", true, nil }
	getenv := func(name string) string { return environment[name] }
	value, source, err := resolveBridgeProxy(getenv, system)
	if err != nil || value != environment["HTTPS_PROXY"] || source != "environment" || systemCalled {
		t.Fatal("explicit environment proxy must keep precedence")
	}
	environment["VIDEOLENS_PROXY_URL"] = "direct"
	value, _, err = resolveBridgeProxy(getenv, system)
	if err != nil || value != "direct" {
		t.Fatal("explicit direct mode must remain available")
	}
	delete(environment, "HTTPS_PROXY")
	delete(environment, "VIDEOLENS_PROXY_URL")
	value, source, err = resolveBridgeProxy(getenv, system)
	if err != nil || value != "http://127.0.0.1:7890" || source != "system" {
		t.Fatal("Native hosts without proxy environment must inherit Windows settings")
	}
	value, source, err = resolveBridgeProxy(getenv, func() (string, bool, error) { return "old-proxy:80", false, nil })
	if err != nil || value != "" || source != "default" {
		t.Fatal("disabled system proxy must not be used")
	}
	environment["HTTPS_PROXY"] = "not-valid-with-private-password"
	_, _, err = resolveBridgeProxy(getenv, system)
	if err == nil || strings.Contains(err.Error(), "private-password") {
		t.Fatal("invalid proxy errors must not expose configuration values")
	}
}

func TestConfiguredProxyReachesSDKTransport(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Host != "provider.invalid" {
			t.Error("request did not reach the configured proxy")
		}
		_, _ = w.Write([]byte("proxied"))
	}))
	defer proxy.Close()
	directory := t.TempDir()
	path := filepath.Join(directory, "config.yaml")
	if err := writeBridgeConfig(path, filepath.Join(directory, "auths"), bridgeSecrets{ClientAPIKey: "test-client", ManagementKey: "test-management"}, proxy.URL); err != nil {
		t.Fatal(err)
	}
	config, err := proxyconfig.LoadConfig(path)
	if err != nil || config.ProxyURL != proxy.URL {
		t.Fatal("generated SDK config must retain the selected proxy")
	}
	transport, _, err := proxyutil.BuildHTTPTransport(config.ProxyURL)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	response, err := client.Get("http://provider.invalid/test")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if string(body) != "proxied" {
		t.Fatal("SDK request must use the selected proxy")
	}
}
