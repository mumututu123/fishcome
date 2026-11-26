package main

import (
	"net"
	"slices"
	"testing"
)

func TestInvitesPublishOnlyUsableAddresses(t *testing.T) {
	publicDefault := net.ParseIP("198.51.100.10")
	lan := net.ParseIP("192.168.1.10")
	vpn := net.ParseIP("100.64.1.10")
	got := inviteEndpoints(39241, []net.IP{publicDefault, lan, vpn, lan})
	want := []string{"http://192.168.1.10:39241", "http://100.64.1.10:39241"}
	if !slices.Equal(got, want) {
		t.Fatalf("usable LAN endpoints = %v, want %v", got, want)
	}
	got = inviteEndpoints(39241, []net.IP{publicDefault, nil})
	if !slices.Equal(got, []string{"http://127.0.0.1:39241"}) {
		t.Fatalf("without a usable LAN address, endpoints = %v, want loopback", got)
	}
}
