// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"log/slog"
	"net"
	"slices"
	"testing"

	"github.com/miekg/dns"
)

// TestAdvertRecords checks the records answered, without a responder (no
// multicast in tests).
func TestAdvertRecords(t *testing.T) {
	ad := &advertiser{log: slog.New(slog.DiscardHandler)}
	ad.set([]advert{
		{zone: "front", name: "Glowstack Front", mac: "020000000001", ip: net.ParseIP("192.0.2.50"), port: 80},
		{zone: "porch", name: "Glowstack Porch", mac: "020000000002", ip: net.ParseIP("192.0.2.51"), port: 80},
	})
	var ptrs []string
	for _, rr := range ad.Records(dns.Question{Name: "_wled._tcp.local.", Qtype: dns.TypePTR, Qclass: dns.ClassINET}) {
		if p, ok := rr.(*dns.PTR); ok {
			ptrs = append(ptrs, p.Ptr)
		}
	}
	slices.Sort(ptrs)
	if want := []string{"Glowstack Front._wled._tcp.local.", "Glowstack Porch._wled._tcp.local."}; !slices.Equal(ptrs, want) {
		t.Fatalf("PTR %v, want %v", ptrs, want)
	}
	var txt []string
	var srv *dns.SRV
	for _, rr := range ad.Records(dns.Question{Name: "Glowstack Front._wled._tcp.local.", Qtype: dns.TypeANY, Qclass: dns.ClassINET}) {
		switch rr := rr.(type) {
		case *dns.TXT:
			txt = rr.Txt
		case *dns.SRV:
			srv = rr
		}
	}
	if !slices.Equal(txt, []string{"mac=020000000001"}) || srv == nil || srv.Port != 80 || srv.Target != "glowstack-front.local." {
		t.Errorf("TXT %v SRV %v", txt, srv)
	}
	if rrs := ad.Records(dns.Question{Name: "_http._tcp.local.", Qtype: dns.TypePTR, Qclass: dns.ClassINET}); len(rrs) == 0 {
		t.Error("no _http._tcp records")
	}
	if mdnsHost("Shed West") != "glowstack-shed-west" {
		t.Errorf("mdnsHost = %q", mdnsHost("Shed West"))
	}
}
