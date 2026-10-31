// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package wled

import (
	"log/slog"
	"net"
	"strings"
	"sync"

	"github.com/hashicorp/mdns"
	"github.com/miekg/dns"
)

// mdnsHost is a zone device's mDNS host name (without ".local").
func mdnsHost(zone string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(zone) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return "glowstack-" + b.String()
}

// advert is one device's advertisement.
type advert struct {
	zone, name, mac string
	ip              net.IP
	port            int
}

// adverts lists the running devices as WLED advertises itself: its host
// name, _wled._tcp with the MAC in the TXT record (Home Assistant's
// discovery reads it), and _http._tcp. A device listening on every address
// is advertised with the host's addresses.
func (d *Devices) adverts() []advert {
	cfg := d.a.Current().Config
	addrs := d.Addrs()
	var out []advert
	for _, z := range deviceZones(cfg) {
		a, ok := addrs[z.ID]
		if !ok {
			continue
		}
		tcp, _ := a.(*net.TCPAddr)
		if tcp == nil {
			continue
		}
		hw, _ := net.ParseMAC(z.Device.MAC)
		ad := advert{zone: z.ID, name: z.Device.Name, mac: strings.ReplaceAll(hw.String(), ":", ""), port: tcp.Port}
		if !tcp.IP.IsUnspecified() {
			ad.ip = tcp.IP
		}
		out = append(out, ad)
	}
	return out
}

// advertiser answers mDNS queries for the devices. One responder serves
// every device; set swaps the records it answers with.
type advertiser struct {
	log *slog.Logger
	srv *mdns.Server

	mu    sync.RWMutex
	zones multiZone
}

func newAdvertiser(l *slog.Logger) *advertiser {
	ad := &advertiser{log: l}
	srv, err := mdns.NewServer(&mdns.Config{Zone: ad, Logger: slog.NewLogLogger(l.Handler(), slog.LevelDebug)})
	if err != nil {
		l.Warn("mdns: can't advertise the devices", "err", err)
		return ad
	}
	ad.srv = srv
	return ad
}

// Records implements mdns.Zone.
func (ad *advertiser) Records(q dns.Question) []dns.RR {
	ad.mu.RLock()
	defer ad.mu.RUnlock()
	return ad.zones.Records(q)
}

// set replaces the advertised devices.
func (ad *advertiser) set(devs []advert) {
	var zones multiZone
	for _, dv := range devs {
		host := mdnsHost(dv.zone) + ".local."
		ips := hostIPs()
		if dv.ip != nil {
			ips = []net.IP{dv.ip}
		}
		txt := []string{"mac=" + dv.mac}
		for _, svc := range []string{"_wled._tcp", "_http._tcp"} {
			s, err := mdns.NewMDNSService(dnsLabel(dv.name), svc, "local.", host, dv.port, ips, txt)
			if err != nil {
				ad.log.Warn("mdns: not advertising", "zone", dv.zone, "service", svc, "err", err)
				continue
			}
			zones = append(zones, s)
		}
		if ad.srv != nil {
			ad.log.Info("mdns: advertising", "zone", dv.zone, "host", host, "port", dv.port)
		}
	}
	ad.mu.Lock()
	ad.zones = zones
	ad.mu.Unlock()
}

func (ad *advertiser) close() {
	if ad.srv != nil {
		_ = ad.srv.Shutdown()
	}
}

// dnsLabel makes an instance name safe in a DNS label.
func dnsLabel(s string) string {
	s = strings.NewReplacer(".", " ", "\\", " ").Replace(s)
	if len(s) > 63 {
		s = s[:63]
	}
	return s
}

func hostIPs() []net.IP {
	var out []net.IP
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			out = append(out, n.IP)
		}
	}
	return out
}

// multiZone answers for several services, without repeating records two
// of them share (the host's A record).
type multiZone []*mdns.MDNSService

func (z multiZone) Records(q dns.Question) []dns.RR {
	var out []dns.RR
	seen := map[string]bool{}
	for _, s := range z {
		for _, rr := range s.Records(q) {
			if k := rr.String(); !seen[k] {
				seen[k] = true
				out = append(out, rr)
			}
		}
	}
	return out
}
