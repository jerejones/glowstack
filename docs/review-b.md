# Independent review B

Reviewed effects, palettes, presets/composites, output/DDP/health, native API,
CLI, HTTP lifecycle and live map against `docs/design.md` and
`docs/architecture.md`. Base: `7a909c3`. Review date: 2026-10-31.

15 confirmed bugs were reproduced with failing tests and fixed. Each numbered
item below has its own **Test** commit followed by its **Fix** commit. No push
or merge was performed.

## Bugs fixed

Severity: P1 = high (stale hardware destination); P2 = medium (incorrect
behaviour or lifecycle); P3 = low (small bias, diagnostic or validation issue).

1. **P1 — Failed output rebuild retained stale controller destinations.**
   Removing one explicitly selected controller made selection fail after the
   app had accepted the new layout. Existing senders and health targets
   remained active, so frames for remaining IDs could reach old endpoints.
   A failed rebuild now closes old senders and clears targets. A subsequent
   valid reload restores the explicitly selected set.
   Test: `29985ab`; fix: `85298a1`.

2. **P2 — Chase colours jumped at spacing boundaries.** Motion was reduced
   modulo one pulse spacing instead of the complete colour cycle. Moving by
   one spacing incorrectly restored the same pulse colour, in either
   direction. Phase reduction now preserves the full colour cycle.
   Test: `02630ba`; fix: `e416493`.

3. **P3 — Dither discarded small fractional byte errors.** A dead band around
   integer byte levels permanently rounded those levels, including very dim
   nonzero output. The quantiser now carries every fractional error, uses
   float64 for accumulation and preserves exact black/full endpoints.
   Test: `2d55d26`; fix: `a829975`.

4. **P2 — Controller endpoint changes reused old health settings.** An ID
   moved to another endpoint retained the former endpoint's cached config.
   Old in-flight responses could also overwrite replacement health. Endpoint
   changes now invalidate cached status/config and discard obsolete results.
   Tests include an in-flight replacement, under the race detector.
   Test: `038185f`; fix: `20e4726`.

5. **P2 — Offline polls hid controller reboots.** Reboot detection required
   the preceding poll to have succeeded. An outage followed by a lower uptime
   therefore skipped both the reboot count and settings refresh. Detection
   now compares the last successfully observed uptime across failed polls.
   Test: `78a7ce2`; fix: `d378b69`.

6. **P2 — Random palette fades depended on render history.** The cache grouped
   fade times into 10 ms buckets but cached the first actual time seen. House
   and scrubbed preview instances could produce different colours for the
   same timestamp. Fades now cache by the exact frame time.
   Test: `c539c42`; fix: `21d6723`.

7. **P2 — Concurrent API patches lost independent changes.** Each request
   merged against an earlier snapshot and later replaced the whole layer.
   The final mutation now merges into the current layer under the stack's
   lock; validation still checks the resulting layer.
   Test: `821deb5`; fix: `c60c097`.

8. **P3 — Malformed trailing JSON was accepted.** `Decoder.More` did not
   reject a closing bracket/brace after a complete request object. Requests
   now require EOF after the object, before changing state.
   Test: `035492b`; fix: `c03a12a`.

9. **P2 — Caller-chosen house IDs collided with preview IDs.** A house layer
   named `preview:p1` collided with the map's renamed preview layer and was
   also misidentified in house-frame inspection. Both stacks now receive
   disjoint namespaces in the preview engine; inspection decodes namespaces
   only for preview snapshots. House output/state remain separate.
   Test: `3f4e603`; fix: `aa6ce1b`.

10. **P2 — Switching effects retained old effect parameters.** Shared names
    such as `color` leaked into the new effect, contrary to the documented
    edit semantics. Switching looks now clears effect overrides while keeping
    common layer parameters. Naming the current look still merges normally.
    Test: `d6a09e2`; fix: `7c73a4f`.

11. **P3 — Map power estimates used the wrong auto-white channels.** The map
    counted authored W on RGBW auto-white controllers, while the pipeline
    folds it into RGB before limiting. The map now follows the same folding
    rule. Explicit-white estimates retain their previous channel semantics.
    Test: `ee60cfd`; fix: `7c5c6c0`.

12. **P2 — WLED sliders lost structured physical length measures.** Lengths
    supplied as `{value, measure}` became flow lengths when a slider changed
    their magnitude. Slider formatting now retains the physical measure for
    the structured form as well as the string suffix.
    Test: `c6e059f`; fix: `94d1af3`.

13. **P2 — Fake UDP receivers leaked cancellation watchers after read errors.**
    `ServeUDP` could return while its watcher waited forever for caller
    cancellation. The watcher now also exits when receiving ends. A Go
    `synctest` regression deterministically detected the leaked goroutine.
    Test: `d7aa4a2`; fix: `04a15f0`.

14. **P2 — Sub-pixel chase heads used the wrong pulse colour.** A pixel centred
    in a gap but partially covering the next pulse used the previous pulse's
    colour; footprints spanning several pulses also used only one colour.
    Chase now averages each pulse colour's coverage across the footprint.
    Test: `586a296`; fix: `1b8946d`.

15. **P2 — Soft bands bypassed footprint filtering.** Soft edges always sampled
    the pixel centre, so compressed patterns and pixels around band centres
    did not match the specified box filter. The renderer now integrates the
    linear colour transitions over each footprint; `smooth: false` still
    samples the centre.
    Test: `3daa8b0`; fix: `b74e8e6`.

## Verification

- `go vet ./...` passed.
- `go test -race ./...` passed after all functional changes.
- `scripts/check-license-headers.sh --all` and `git diff --check` passed.
  The pre-commit hook was enabled and used for every commit.
- Existing tests cover sparkle event counts/density across frame rates and
  stretch, deterministic subset rendering, glitter/primitive-stack
  equivalence, hard-band coverage, palette interpolation/wrapping, slider
  curve round trips, white handling, limit groups, controller totals, idle
  current, attack/release, DDP packet bytes, sequence wrapping, coalescing,
  unreachable controllers, API persistence and concurrent reload/rendering.
- Compared all **60 gradient palettes** with WLED's current
  [palette source](https://github.com/wled/WLED/blob/main/wled00/palettes.cpp);
  all stop bytes matched. Also spot-checked the Cloud, Lava, Ocean and Forest
  16-entry palette ordering/values. WLED has moved the brief's `palettes.h`
  to `palettes.cpp`.
- Compared DDP flags, RGB/RGBW type bytes, byte offsets, push handling and
  sequence acceptance with WLED's
  [receiver](https://github.com/wled/WLED/blob/main/wled00/e131.cpp) and
  [protocol definitions](https://github.com/wled/WLED/blob/main/wled00/src/dependencies/e131/ESPAsyncE131.h).
  Current WLED places `handleDDPPacket` in `e131.cpp`, rather than the
  brief's `udp.cpp`. The protocol definitions include the DDP specification
  reference; that separate non-GitHub site was not fetched under the brief's
  network restriction.
- The health monitor uses GET requests only. Fake-controller CLI address
  checks accept loopback literals/localhost and reject other bind addresses.
  The default program selection is `none`; loopback-only fakes default to
  `all`. The rebuilt program was also exercised without an `--output` flag;
  controller health was empty, consistent with no selected output targets.
- Exercised the rebuilt map in an invisible Chromium preview on loopback:
  live frames, flow/stretch/area views, preview glitter, pause, step, seek,
  speed/resume, clear, and reload. No console errors or unhandled rejections;
  the house stack was unchanged by preview actions. After reload the page
  loaded generation 1 and resumed house frames. The browser may record the
  reload request as aborted when the expected generation change navigates
  the page, after its successful HTTP response.
- Network activity was limited to loopback and fetching WLED source from
  GitHub into `/tmp`. No installation data was added.

## Design concerns left unchanged

- **Composite reload policy:** configured composites are registered once in
  the effect registry, which architecture decision 34 deliberately keeps
  unchanged on reload. Adding/changing a composite therefore needs a restart,
  unlike ordinary preset/palette edits. Decide whether composite definitions
  should eventually be rebuilt with each config generation.
- **Power accounting after controller auto-white:** the pipeline estimates
  the RGB wire values it sends, while a controller in auto-white mode may
  derive a different physical channel mix. Exact current accounting requires
  a documented controller conversion model or explicit white handling.
- **Instantaneous versus average power:** limits are calculated on continuous
  drive levels before quantisation/dithering. Integer rounding can put a
  particular frame slightly above that continuous estimate. Decide whether
  the power contract requires a conservative instantaneous byte-level cap.
- **Reload latency:** sender replacement waits synchronously for old workers
  to finish. Packet pacing and hostname resolution can extend reload/frame
  latency even though ordinary `Send` calls remain nonblocking. A bounded,
  cancellable replacement policy is a possible future improvement.
- **Polling observability:** uptime-only health polling cannot reliably infer
  every reboot if the new uptime has already exceeded the last observed
  uptime, and successful UDP writes do not establish frame delivery. These
  are observability limits, not claims of delivery acknowledgement.
