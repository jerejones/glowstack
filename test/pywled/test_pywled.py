# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Drive Glowstack's WLED devices with python-wled, Home Assistant's own
WLED library, and check the stack through Glowstack's native API.

    python test_pywled.py --api http://127.0.0.1:8080 \\
        --device front=127.0.0.1:40080 --device porch=127.0.0.1:40081

internal/wled/pywled_test.go runs it against glowstack on the fictional
example. python-wled only talks to port 80, so the device hosts given here
are made-up names that a patched URL builder sends to the given ports.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request

import aiohttp
import wled.wled
from wled import WLED
from yarl import URL

PORTS: dict[str, tuple[str, int]] = {}


class _URL:
    """yarl.URL whose build sends the test's device names to their ports."""

    def __new__(cls, *args, **kwargs):
        return URL(*args, **kwargs)

    @staticmethod
    def build(**kw):
        if kw.get("host") in PORTS:
            kw["host"], kw["port"] = PORTS[kw["host"]]
        return URL.build(**kw)


wled.wled.URL = _URL


class Native:
    """Glowstack's control API."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")

    def get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return json.load(r)

    def send(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def layers(self, owner: str) -> list[dict]:
        return [l for l in self.get("/api/v1/layers")["layers"] if l.get("owner") == owner]

    def brightness(self, zone: str) -> float:
        return self.get("/api/v1/brightness")["zones"][zone]


CHECKS = 0


def check(cond: bool, what: str) -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(what)
    print("ok:", what)


async def test_front(led: WLED, api: Native) -> None:
    dev = await led.update()
    info = dev.info
    check(info.brand == "WLED", f"brand {info.brand}")
    check(info.mac_address == "020000000001", f"mac {info.mac_address}")
    check(info.name == "Glowstack Front", f"name {info.name}")
    check(info.leds.count > 0, f"leds.count {info.leds.count}")
    check(str(info.version).startswith("16."), f"version {info.version}")
    check(len(dev.state.segments) == 3, f"{len(dev.state.segments)} segments")
    names = {e.name for e in dev.effects.values()}
    check({"Solid", "Glitter", "Ember glitter"} <= names, "effects list has Solid, Glitter and the composite")
    check("RSVD" not in names, "no RSVD placeholders")
    check(any(p.name == "Rainbow" for p in dev.palettes.values()), "palettes list has Rainbow")
    check(any(p.name == "Slow crawl" for p in dev.presets.values()), "presets list has Slow crawl")

    owner = "wled-device:front/1"
    # Home Assistant's turn_on for a segment light.
    await led.segment(1, on=True, brightness=255)
    await led.master(on=True, brightness=200)
    ls = api.layers(owner)
    check(len(ls) == 1 and ls[0]["target"] == "shed", "segment 1 on pushes a layer on shed")
    check(abs(api.brightness("front") - 200 / 255) < 1e-6, "master bri 200 is the zone brightness")

    dev = await led.update()
    check(dev.state.segments[1].on is True, "segment 1 reads back on")
    check(dev.state.segments[0].on is False, "segment 0 reads back off")
    check(dev.state.on and dev.state.brightness == 200, "device on at 200")

    # Effect, palette, colour, speed and intensity.
    await led.segment(1, effect="Palette", palette="Rainbow", color_primary=(255, 0, 0),
                      color_secondary=(0, 0, 255), speed=180, intensity=60)
    ls = api.layers(owner)
    check(ls[0]["effect"] == "gradient", f"effect is {ls[0]['effect']}")
    dev = await led.update()
    seg = dev.state.segments[1]
    check(dev.effects[int(seg.effect_id)].name == "Palette", "effect reads back Palette (gradient)")
    check(dev.palettes[int(seg.palette_id)].name == "Rainbow", "palette reads back Rainbow")
    check(abs(int(seg.speed) - 180) <= 2, f"speed reads back {seg.speed}")
    check(abs(int(seg.intensity) - 60) <= 2, f"intensity reads back {seg.intensity}")
    check(tuple(seg.color.primary[:3]) == (255, 0, 0), f"primary {seg.color.primary}")

    # HA's number and palette select entities send separate partial updates.
    await led.segment(1, speed=31)
    await led.segment(1, intensity=219)
    await led.segment(1, palette="Ember")
    dev = await led.update()
    seg = dev.state.segments[1]
    check(abs(int(seg.speed) - 31) <= 2, f"speed number reads back {seg.speed}")
    check(abs(int(seg.intensity) - 219) <= 2, f"intensity number reads back {seg.intensity}")
    check(dev.palettes[int(seg.palette_id)].name == "Ember", "palette select reads back a user palette by name")
    check(dev.state.segments[0].on is False, "partial number/select writes leave segment 0 alone")

    # Controls can be prepared while the segment is off without pushing it.
    await led.segment(2, speed=37)
    await led.segment(2, intensity=221)
    await led.segment(2, palette="Rainbow")
    dev = await led.update()
    seg = dev.state.segments[2]
    check(not seg.on and int(seg.speed) == 37 and int(seg.intensity) == 221,
          "number writes on an off segment are remembered without a layer")
    check(dev.palettes[int(seg.palette_id)].name == "Rainbow", "off segment remembers its palette select")
    check(api.layers("wled-device:front/2") == [], "off segment controls do not push a layer")

    await led.segment(1, effect="Solid", color_primary=(0, 255, 0))
    ls = api.layers(owner)
    check(ls[0]["effect"] == "solid", "effect Solid")
    await led.segment(1, color_primary=(10, 20, 30, 40))
    dev = await led.update()
    check(tuple(dev.state.segments[1].color.primary) == (10, 20, 30, 40), "RGBW segment color round-trips")
    # Black is a colour: still a layer.
    await led.segment(1, color_primary=(0, 0, 0))
    check(len(api.layers(owner)) == 1, "black keeps the layer")
    # Segment brightness.
    await led.segment(1, brightness=128)
    dev = await led.update()
    check(dev.state.segments[1].brightness == 128, f"segment bri {dev.state.segments[1].brightness}")

    # Device off is a brightness gate; the layer stays.
    await led.master(on=False)
    check(api.brightness("front") == 0, "device off sets zone brightness 0")
    check(len(api.layers(owner)) == 1, "device off keeps the layer")
    dev = await led.update()
    check(dev.state.on is False and dev.state.segments[1].on, "reads back device off, segment on")
    await led.master(on=True)
    check(abs(api.brightness("front") - 200 / 255) < 1e-6, "device on comes back at 200")

    # Segment off removes the layer.
    await led.segment(1, on=False)
    check(api.layers(owner) == [], "segment off removes the layer")

    # A preset's common parameters must be editable by HA's segment light
    # and reverse switch, including resetting them to their default values.
    api.send("PUT", "/api/v1/presets/dim-reversed", {
        "name": "Dim reversed", "effect": "solid",
        "params": {"brightness": 0.25, "reverse": True},
    })
    dev = await led.update()
    check(any(p.name == "Dim reversed" for p in dev.presets.values()), "preset select sees a native saved preset")
    await led.preset("Dim reversed")
    await led.segment(0, brightness=255)
    await led.segment(0, reverse=False)
    dev = await led.update()
    check(dev.state.segments[0].brightness == 255 and not dev.state.segments[0].reverse,
          "segment light and reverse switch reset preset common parameters")

    # Presets.
    dev = await led.update()
    glitter = next(p for p in dev.presets.values() if p.name == "Glitter")
    await led.preset("Glitter")
    ls = api.layers("wled-device:front/0")
    check(len(ls) == 1 and ls[0].get("preset") == "glitter", "preset Glitter on the main segment")
    dev = await led.update()
    check(dev.state.preset_id == glitter.preset_id, f"state ps {dev.state.preset_id}")
    check(dev.effects[int(dev.state.segments[0].effect_id)].name == "Glitter", "preset shows effect Glitter")
    await led.request("/json/state", method="POST", data={"mainseg": 1})
    await led.preset("Glitter")
    dev = await led.update()
    check(dev.state.preset_id == glitter.preset_id and bool(api.layers(owner)),
          "preset select targets the configured main segment")
    await led.segment(1, on=False)
    await led.request("/json/state", method="POST", data={"mainseg": 0})

    # Pushes over the websocket, for changes made outside the device too.
    await led.connect()
    seen: list = []
    task = asyncio.create_task(led.listen(lambda d: seen.append(d)))
    await asyncio.sleep(0.3)
    api.send("DELETE", "/api/v1/layers/" + ls[0]["id"])
    for _ in range(50):
        if seen and not seen[-1].state.segments[0].on:
            break
        await asyncio.sleep(0.1)
    check(bool(seen) and not seen[-1].state.segments[0].on, "websocket pushes a layer removed through the native API")
    api.send("PUT", "/api/v1/brightness", {"zones": {"front": 0.25}})
    for _ in range(50):
        if seen and seen[-1].state.brightness == 64:
            break
        await asyncio.sleep(0.1)
    check(bool(seen) and seen[-1].state.brightness == 64, "websocket pushes a zone brightness set through the native API")
    await led.disconnect()
    task.cancel()


async def test_porch(led: WLED, api: Native) -> None:
    dev = await led.update()
    check(dev.info.mac_address == "020000000002", "porch is its own device")
    check(len(dev.state.segments) == 2, "porch has 2 segments")
    await led.segment(0, on=True, color_primary=(0, 0, 255))
    ls = api.layers("wled-device:porch/0")
    check(len(ls) == 1 and ls[0]["target"] == "porch", "porch segment 0 on porch")
    check(api.layers("wled-device:front/0") == [], "front is untouched")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", required=True)
    ap.add_argument("--device", action="append", default=[], help="zone=HOST:PORT")
    args = ap.parse_args()
    for d in args.device:
        zone, addr = d.split("=", 1)
        host, port = addr.rsplit(":", 1)
        PORTS[zone + ".test"] = (host, int(port))
    api = Native(args.api)
    async with aiohttp.ClientSession() as session:
        await test_front(WLED("front.test", session=session), api)
        await test_porch(WLED("porch.test", session=session), api)
    print(f"PASS: {CHECKS} checks")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
