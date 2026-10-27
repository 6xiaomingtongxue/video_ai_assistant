package main

import (
	"errors"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/proxyutil"
)

func resolveBridgeProxy(getenv func(string) string, systemProxy func() (string, bool, error)) (string, string, error) {
	for _, name := range []string{"VIDEOLENS_PROXY_URL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if value := strings.TrimSpace(getenv(name)); value != "" {
			if _, err := proxyutil.Parse(value); err != nil {
				return "", "", errors.New("Bridge 网络代理配置无效，请检查代理环境变量。")
			}
			return value, "environment", nil
		}
	}
	value, enabled, err := systemProxy()
	if err != nil {
		return "", "", errors.New("无法读取 Windows 系统代理设置。")
	}
	if !enabled {
		return "", "default", nil
	}
	proxyURL, err := normalizeSystemProxy(value)
	if err != nil {
		return "", "", err
	}
	return proxyURL, "system", nil
}

func normalizeSystemProxy(value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.EqualFold(value, "direct") || strings.EqualFold(value, "none") {
		return "", errors.New("Windows 系统代理地址无效，请检查系统代理设置。")
	}
	scheme := "http"
	firstKey := strings.ToLower(strings.TrimSpace(strings.SplitN(value, "=", 2)[0]))
	if firstKey == "http" || firstKey == "https" || firstKey == "socks" {
		servers := map[string]string{}
		for _, pair := range strings.Split(value, ";") {
			parts := strings.SplitN(pair, "=", 2)
			if len(parts) == 2 {
				servers[strings.ToLower(strings.TrimSpace(parts[0]))] = strings.TrimSpace(parts[1])
			}
		}
		value = ""
		for _, protocol := range []string{"https", "http", "socks"} {
			if servers[protocol] != "" {
				value = servers[protocol]
				if protocol == "socks" {
					scheme = "socks5"
				}
				break
			}
		}
	}
	if value != "" && !strings.Contains(value, "://") {
		value = scheme + "://" + value
	}
	setting, err := proxyutil.Parse(value)
	if err != nil || setting.Mode != proxyutil.ModeProxy || setting.URL.RawQuery != "" || setting.URL.Fragment != "" || (setting.URL.Path != "" && setting.URL.Path != "/") {
		return "", errors.New("Windows 系统代理地址无效，请检查系统代理设置。")
	}
	return setting.URL.String(), nil
}
