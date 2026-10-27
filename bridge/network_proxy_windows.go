package main

import "golang.org/x/sys/windows/registry"

func systemProxyServer() (string, bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err == registry.ErrNotExist {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	defer key.Close()
	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err == registry.ErrNotExist || (err == nil && enabled == 0) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	server, _, err := key.GetStringValue("ProxyServer")
	return server, true, err
}
