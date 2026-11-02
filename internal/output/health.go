// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package output

import "time"

// ControllerHealth is a snapshot of controller checks and DDP traffic.
// Its zero value means output is disabled and reachability is unknown.
type ControllerHealth struct {
	Reachable *bool      `json:"reachable"` // nil until an HTTP check completes
	LastSeen  *time.Time `json:"last_seen"` // last successful /json/info check
	Errors    uint64     `json:"send_errors"`
	LastError string     `json:"last_error"` // current check error, otherwise last send error
	Sending   bool       `json:"sending"`    // selected for output, regardless of reachability

	Checked    time.Time `json:"checked,omitzero"`
	Version    string    `json:"version,omitempty"`
	Uptime     float64   `json:"uptime_s,omitempty"`
	Count      int       `json:"led_count,omitempty"`
	Reboots    int       `json:"reboots"`
	Mismatches []string  `json:"mismatches,omitempty"`
	Err        string    `json:"error,omitempty"` // current HTTP check error

	Frames        uint64    `json:"frames"`
	Packets       uint64    `json:"packets"`
	Bytes         uint64    `json:"bytes"`
	Coalesced     uint64    `json:"coalesced"`
	LastSendError string    `json:"last_send_error,omitempty"`
	ErrorAt       time.Time `json:"last_send_error_at,omitzero"`
}

// HealthReporter is implemented by a sink or stage with controller health.
// Reports may contain only monitored controllers; the API fills in the rest.
type HealthReporter interface {
	Health() map[string]ControllerHealth
}
