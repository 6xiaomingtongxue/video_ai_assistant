//go:build !windows

package main

func systemProxyServer() (string, bool, error) { return "", false, nil }
