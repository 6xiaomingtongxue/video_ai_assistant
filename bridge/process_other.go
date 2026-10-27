//go:build !windows

package main

import "os/exec"

func hideProcessWindow(command *exec.Cmd) {}
