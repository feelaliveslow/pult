#!/usr/bin/env python3
"""Пульт — программа для ноутбука.

Захватывает экран, отправляет его на iPhone по WebRTC (H.264, низкая задержка)
и выполняет команды мыши и клавиатуры, которые приходят с телефона.

Запуск:  python server.py            (порт 8765)
         python server.py --help     (все параметры)
"""

from __future__ import annotations

import argparse
import asyncio
import fractions
import hmac
import ipaddress
import json
import logging
import os
import platform
import secrets
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SYSTEM = platform.system()  # "Windows" | "Darwin" | "Linux"

if SYSTEM == "Windows":
    # Без этого на экранах с масштабом 125%/150% координаты кликов уезжают.
    import ctypes

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import av  # noqa: E402
import mss  # noqa: E402
import numpy as np  # noqa: E402
from aiohttp import web  # noqa: E402
from aiortc import (  # noqa: E402
    RTCConfiguration,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from aiortc.codecs import h264 as h264mod  # noqa: E402
from aiortc.codecs import vpx as vpxmod  # noqa: E402
from aiortc.rtcrtpsender import RTCRtpSender  # noqa: E402
from pynput.keyboard import Controller as KeyController  # noqa: E402
from pynput.keyboard import Key, KeyCode  # noqa: E402
from pynput.mouse import Button  # noqa: E402
from pynput.mouse import Controller as MouseController  # noqa: E402

log = logging.getLogger("pult")

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT.parent / "web"
CONFIG_DIR = Path.home() / ".screen-viewer"
CONFIG_FILE = CONFIG_DIR / "config.json"
VIDEO_CLOCK = 90000


# --------------------------------------------------------------------------
# Видеокодек: быстрее и чётче, чем настройки aiortc по умолчанию
# --------------------------------------------------------------------------

class Settings:
    """Текущие параметры потока; меняются с телефона на лету."""

    def __init__(self) -> None:
        self.width = 1280  # максимальная ширина кадра в пикселях
        self.fps = 30
        self.kbps = 2500


SETTINGS = Settings()


def _set_bitrate_limits(kbps: int) -> None:
    bps = int(kbps * 1000)
    for mod in (h264mod, vpxmod):
        mod.DEFAULT_BITRATE = bps
        mod.MAX_BITRATE = bps
        mod.MIN_BITRATE = min(mod.MIN_BITRATE, bps)


def _h264_encode_frame(self, frame: av.VideoFrame, force_keyframe: bool):
    """Замена H264Encoder._encode_frame: preset veryfast + ограничение пиков битрейта.

    Стандартный aiortc кодирует с preset=medium — это заметно грузит процессор
    и добавляет задержку на ноутбуке.
    """
    if self.codec and (
        frame.width != self.codec.width
        or frame.height != self.codec.height
        or abs(self.target_bitrate - self.codec.bit_rate) / self.codec.bit_rate > 0.1
    ):
        self.buffer_data = b""
        self.buffer_pts = None
        self.codec = None

    frame.pict_type = (
        av.video.frame.PictureType.I if force_keyframe else av.video.frame.PictureType.NONE
    )

    if self.codec is None:
        fps = max(1, int(SETTINGS.fps))
        kbps = max(200, int(self.target_bitrate / 1000))
        codec = av.CodecContext.create("libx264", "w")
        codec.width = frame.width
        codec.height = frame.height
        codec.bit_rate = self.target_bitrate
        codec.pix_fmt = "yuv420p"
        codec.framerate = fractions.Fraction(fps, 1)
        codec.time_base = fractions.Fraction(1, fps)
        codec.options = {
            "preset": "veryfast",
            "tune": "zerolatency",
            "level": "42",
            "x264-params": f"vbv-maxrate={int(kbps * 1.3)}:vbv-bufsize={kbps}:keyint={fps * 10}",
        }
        codec.profile = "Baseline"
        self.codec = codec

    data_to_send = b""
    for package in self.codec.encode(frame):
        data_to_send += bytes(package)
    if data_to_send:
        yield from self._split_bitstream(data_to_send)


h264mod.H264Encoder._encode_frame = _h264_encode_frame


# --------------------------------------------------------------------------
# Захват экрана
# --------------------------------------------------------------------------

class Capturer:
    """Снимает экран в отдельном потоке (mss привязан к потоку, где создан)."""

    def __init__(self, monitor_index: int) -> None:
        self.pool = ThreadPoolExecutor(1, thread_name_prefix="capture")
        self._sct = None
        self.monitors: list[dict] = self.pool.submit(self._init).result()
        self.monitor_index = min(max(monitor_index, 0), len(self.monitors) - 1)

    def _init(self) -> list[dict]:
        self._sct = (getattr(mss, "MSS", None) or mss.mss)()
        mons = [dict(m) for m in self._sct.monitors[1:]]
        return mons or [dict(self._sct.monitors[0])]

    @property
    def monitor(self) -> dict:
        return self.monitors[self.monitor_index]

    def _grab(self, max_width: int) -> av.VideoFrame:
        try:
            shot = self._sct.grab(self.monitor)
        except Exception:
            # Монитор отключили / сменилось разрешение — перечитываем список.
            log.warning("Ошибка захвата экрана, переинициализация", exc_info=True)
            self._sct.close()
            self.monitors = self._init()
            self.monitor_index = min(self.monitor_index, len(self.monitors) - 1)
            shot = self._sct.grab(self.monitor)

        w, h = shot.width, shot.height
        arr = np.frombuffer(shot.bgra, dtype=np.uint8).reshape(h, w, 4)
        frame = av.VideoFrame.from_ndarray(arr, format="bgra")
        tw = min(max_width, w) if max_width else w
        th = round(h * tw / w)
        tw -= tw % 2
        th -= th % 2
        return frame.reformat(width=tw, height=th, format="yuv420p", interpolation="AREA")

    async def grab(self, max_width: int) -> av.VideoFrame:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, self._grab, max_width)


class ScreenTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, capturer: Capturer) -> None:
        super().__init__()
        self.capturer = capturer
        self._start: float | None = None
        self._next = 0.0

    async def recv(self) -> av.VideoFrame:
        now = time.monotonic()
        if self._start is None:
            self._start = self._next = now
        else:
            self._next += 1.0 / max(1, SETTINGS.fps)
            delay = self._next - now
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                self._next = now  # не успеваем — не копим отставание
        frame = await self.capturer.grab(SETTINGS.width)
        frame.pts = int((time.monotonic() - self._start) * VIDEO_CLOCK)
        frame.time_base = fractions.Fraction(1, VIDEO_CLOCK)
        return frame


# --------------------------------------------------------------------------
# Мышь и клавиатура
# --------------------------------------------------------------------------

def _key(name: str):
    return getattr(Key, name, None)


SPECIAL_KEYS = {
    name: k
    for name, k in {
        "enter": _key("enter"),
        "esc": _key("esc"),
        "tab": _key("tab"),
        "backspace": _key("backspace"),
        "delete": _key("delete"),
        "space": _key("space"),
        "up": _key("up"),
        "down": _key("down"),
        "left": _key("left"),
        "right": _key("right"),
        "home": _key("home"),
        "end": _key("end"),
        "page_up": _key("page_up"),
        "page_down": _key("page_down"),
        "caps_lock": _key("caps_lock"),
        "print_screen": _key("print_screen"),
        "insert": _key("insert"),
        "menu": _key("menu"),
        "volume_up": _key("media_volume_up"),
        "volume_down": _key("media_volume_down"),
        "volume_mute": _key("media_volume_mute"),
        "play_pause": _key("media_play_pause"),
        **{f"f{i}": _key(f"f{i}") for i in range(1, 13)},
    }.items()
    if k is not None
}

MODIFIERS = {"ctrl": Key.ctrl, "alt": Key.alt, "shift": Key.shift, "cmd": Key.cmd}

# Виртуальные коды клавиш macOS (раскладка ANSI). Нужны, чтобы Cmd+C и т.п.
# работали, даже когда на Mac включена русская раскладка.
MAC_KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "`": 50,
}


def char_key(ch: str):
    """Клавиша по символу — через физический код, независимо от раскладки."""
    c = ch.lower()
    if SYSTEM == "Windows" and c.isascii() and c.isalnum():
        return KeyCode.from_vk(ord(c.upper()))
    if SYSTEM == "Darwin" and c in MAC_KEYCODES:
        return KeyCode.from_vk(MAC_KEYCODES[c])
    return KeyCode.from_char(c)


class X11Typer:
    """Ввод символов на Linux (X11) через расширение XTest.

    pynput печатает буквы через XSendEvent, а многие программы (терминалы,
    часть браузеров) такие события игнорируют. XTest выглядит как настоящая
    клавиатура. Символы, которых нет в раскладке (например кириллица при
    английской раскладке), временно назначаются на свободную клавишу.
    """

    def __init__(self) -> None:
        from Xlib import XK, X, display
        from Xlib.ext import xtest

        self.XK, self.X, self.xtest = XK, X, xtest
        self.d = display.Display()
        self.shift = self.d.keysym_to_keycode(XK.XK_Shift_L)
        first = self.d.display.info.min_keycode
        count = self.d.display.info.max_keycode - first + 1
        mapping = self.d.get_keyboard_mapping(first, count)
        self.spare = [first + i for i, syms in enumerate(mapping) if not any(syms)][-4:]
        self._spare_i = 0

    def _keysym(self, ch: str) -> int:
        name = {" ": "space", "\t": "Tab"}.get(ch)
        ks = self.XK.string_to_keysym(name) if name else 0
        if not ks and ord(ch) < 0x100:
            ks = ord(ch)  # Latin-1: keysym совпадает с кодом символа
        if not ks:
            ks = 0x01000000 | ord(ch)  # Unicode keysym
        return ks

    def _locate(self, ks: int) -> tuple[int, bool]:
        """(keycode, нужен ли Shift)."""
        for kc, index in self.d.keysym_to_keycodes(ks):
            if index in (0, 1):
                return kc, index == 1
        if not self.spare:
            return 0, False
        kc = self.spare[self._spare_i % len(self.spare)]
        self._spare_i += 1
        self.d.change_keyboard_mapping(kc, [(ks, ks)])
        self.d.sync()
        time.sleep(0.01)
        return kc, False

    def _fake(self, kc: int, down: bool) -> None:
        self.xtest.fake_input(self.d, self.X.KeyPress if down else self.X.KeyRelease, kc)

    def press_char(self, ch: str, with_shift_ok: bool = True) -> None:
        kc, need_shift = self._locate(self._keysym(ch))
        if not kc:
            return
        if need_shift and with_shift_ok:
            self._fake(self.shift, True)
        self._fake(kc, True)
        self._fake(kc, False)
        if need_shift and with_shift_ok:
            self._fake(self.shift, False)
        self.d.sync()

    def type(self, text: str) -> None:
        for ch in text:
            self.press_char(ch)


def make_x11_typer():
    if SYSTEM != "Linux":
        return None
    try:
        return X11Typer()
    except Exception:
        log.warning("XTest недоступен — ввод текста через pynput", exc_info=True)
        return None


BUTTONS = {"left": Button.left, "right": Button.right, "middle": Button.middle}


class InputController:
    """Выполняет команды с телефона. Все вызовы идут из одного потока по очереди."""

    DOUBLE_CLICK_TIME = 0.5
    DOUBLE_CLICK_DIST = 6

    def __init__(self, capturer: Capturer) -> None:
        self.cap = capturer
        self.mouse = MouseController()
        self.kb = KeyController()
        self.pool = ThreadPoolExecutor(1, thread_name_prefix="input")
        self.x11 = self.pool.submit(make_x11_typer).result()
        self._scroll_acc = [0.0, 0.0]
        self._last_click = (0.0, None, (0, 0), 0)  # время, кнопка, позиция, счётчик
        self._held_buttons: set = set()
        self._held_mods: list = []

    # ---- координаты ----
    def to_abs(self, x: float, y: float) -> tuple[int, int]:
        m = self.cap.monitor
        x = min(max(float(x), 0.0), 1.0)
        y = min(max(float(y), 0.0), 1.0)
        return (round(m["left"] + x * (m["width"] - 1)), round(m["top"] + y * (m["height"] - 1)))

    def cursor_norm(self) -> tuple[float, float] | None:
        try:
            px, py = self.mouse.position
        except Exception:
            return None
        m = self.cap.monitor
        x = (px - m["left"]) / max(1, m["width"] - 1)
        y = (py - m["top"]) / max(1, m["height"] - 1)
        if -0.01 <= x <= 1.01 and -0.01 <= y <= 1.01:
            return (round(x, 5), round(y, 5))
        return None

    # ---- модификаторы ----
    def _press_mods(self, mods) -> list:
        keys = [MODIFIERS[m] for m in (mods or []) if m in MODIFIERS]
        for k in keys:
            self.kb.press(k)
        return keys

    def _release_mods(self, keys) -> None:
        for k in reversed(keys):
            try:
                self.kb.release(k)
            except Exception:
                pass

    # ---- мышь ----
    def _click_state(self, button) -> int:
        """Номер клика в серии (1, 2, 3) — для двойного/тройного клика."""
        now = time.monotonic()
        pos = self.mouse.position
        t, b, p, n = self._last_click
        near = abs(pos[0] - p[0]) <= self.DOUBLE_CLICK_DIST and abs(pos[1] - p[1]) <= self.DOUBLE_CLICK_DIST
        n = n + 1 if (b == button and now - t < self.DOUBLE_CLICK_TIME and near) else 1
        self._last_click = (now, button, pos, n)
        return min(n, 3)

    def _press(self, button, state: int) -> None:
        if SYSTEM == "Darwin":
            # macOS распознаёт двойной клик только по полю clickState события.
            self.mouse._click = state - 1
            try:
                self.mouse.press(button)
            finally:
                self.mouse._click = None
        else:
            self.mouse.press(button)
        self._held_buttons.add(button)

    def _release(self, button, state: int) -> None:
        if SYSTEM == "Darwin":
            self.mouse._click = state
            try:
                self.mouse.release(button)
            finally:
                self.mouse._click = None
        else:
            self.mouse.release(button)
        self._held_buttons.discard(button)

    def scroll(self, dx: float, dy: float) -> None:
        """dx/dy — сдвиг пальца в пикселях телефона (естественная прокрутка)."""
        self._scroll_acc[0] += dx
        self._scroll_acc[1] += dy
        if SYSTEM == "Windows":
            # Windows принимает дробные «щелчки» колеса → плавная прокрутка.
            sx, sy = self._scroll_acc[0] / 100.0, self._scroll_acc[1] / 100.0
            self._scroll_acc = [0.0, 0.0]
            if abs(sx) > 0.01 or abs(sy) > 0.01:
                self.mouse.scroll(-sx, sy)
            return
        unit = 10.0 if SYSTEM == "Darwin" else 40.0  # пикселей на единицу scroll()
        sx = int(self._scroll_acc[0] / unit)
        sy = int(self._scroll_acc[1] / unit)
        self._scroll_acc[0] -= sx * unit
        self._scroll_acc[1] -= sy * unit
        if sx or sy:
            self.mouse.scroll(-sx, sy)

    # ---- клавиатура ----
    def type_text(self, text: str) -> None:
        parts = text.replace("\r\n", "\n").split("\n")
        for i, part in enumerate(parts):
            if part:
                (self.x11 or self.kb).type(part)
            if i < len(parts) - 1:
                self.kb.press(Key.enter)
                self.kb.release(Key.enter)

    def key(self, name: str, mods) -> None:
        k = SPECIAL_KEYS.get(name) or MODIFIERS.get(name)
        if k is None:
            if not name:
                return
            if self.x11 is not None:
                held = self._press_mods(mods)
                try:
                    self.x11.press_char(name[0], with_shift_ok=False)
                finally:
                    self._release_mods(held)
                return
            k = char_key(name[0])
        held = self._press_mods(mods)
        try:
            self.kb.press(k)
            self.kb.release(k)
        finally:
            self._release_mods(held)

    def release_all(self) -> None:
        for b in list(self._held_buttons):
            try:
                self.mouse.release(b)
            except Exception:
                pass
        self._held_buttons.clear()
        self._release_mods(self._held_mods)
        self._held_mods = []

    # ---- диспетчер ----
    def handle(self, msg: dict) -> None:
        t = msg.get("t")
        if t == "move":
            self.mouse.position = self.to_abs(msg["x"], msg["y"])
        elif t == "rel":
            m = self.cap.monitor
            x, y = self.mouse.position
            nx = min(max(x + float(msg["dx"]) * m["width"], m["left"]), m["left"] + m["width"] - 1)
            ny = min(max(y + float(msg["dy"]) * m["height"], m["top"]), m["top"] + m["height"] - 1)
            self.mouse.position = (round(nx), round(ny))
        elif t == "click":
            if "x" in msg:
                self.mouse.position = self.to_abs(msg["x"], msg["y"])
            button = BUTTONS.get(msg.get("b", "left"), Button.left)
            held = self._press_mods(msg.get("mods"))
            try:
                state = self._click_state(button)
                self._press(button, state)
                self._release(button, state)
            finally:
                self._release_mods(held)
        elif t == "down":
            if "x" in msg:
                self.mouse.position = self.to_abs(msg["x"], msg["y"])
            button = BUTTONS.get(msg.get("b", "left"), Button.left)
            self._held_mods = self._press_mods(msg.get("mods"))
            self._press(button, self._click_state(button))
        elif t == "up":
            if "x" in msg:
                self.mouse.position = self.to_abs(msg["x"], msg["y"])
            button = BUTTONS.get(msg.get("b", "left"), Button.left)
            self._release(button, self._last_click[3] or 1)
            self._release_mods(self._held_mods)
            self._held_mods = []
        elif t == "scroll":
            self.scroll(float(msg.get("dx", 0)), float(msg.get("dy", 0)))
        elif t == "text":
            self.type_text(str(msg.get("s", "")))
        elif t == "key":
            self.key(str(msg.get("k", "")), msg.get("mods"))
        elif t == "release":
            self.release_all()

    async def run(self, msg: dict) -> None:
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(self.pool, self.handle, msg)
        except Exception:
            log.warning("Ошибка выполнения команды %s", msg.get("t"), exc_info=True)

    async def call(self, fn, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.pool, fn, *args)


# --------------------------------------------------------------------------
# Сессия WebRTC
# --------------------------------------------------------------------------

class Session:
    def __init__(self, app_state: "AppState") -> None:
        self.state = app_state
        self.pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.channel = None
        self.sender = None
        self.tasks: list[asyncio.Task] = []
        self.closed = False

    def send(self, obj: dict) -> None:
        ch = self.channel
        if ch is not None and ch.readyState == "open":
            try:
                ch.send(json.dumps(obj, separators=(",", ":")))
            except Exception:
                pass

    def hello(self) -> dict:
        cap = self.state.capturer
        return {
            "t": "hello",
            "os": {"Windows": "windows", "Darwin": "mac"}.get(SYSTEM, "linux"),
            "host": socket.gethostname(),
            "monitors": [{"w": m["width"], "h": m["height"]} for m in cap.monitors],
            "mon": cap.monitor_index,
            "cfg": {"w": SETTINGS.width, "fps": SETTINGS.fps, "kbps": SETTINGS.kbps},
        }

    def apply_config(self, msg: dict) -> None:
        if "w" in msg:
            SETTINGS.width = int(min(max(int(msg["w"]), 320), 3840))
        if "fps" in msg:
            SETTINGS.fps = int(min(max(int(msg["fps"]), 5), 60))
        if "kbps" in msg:
            SETTINGS.kbps = int(min(max(int(msg["kbps"]), 300), 20000))
        _set_bitrate_limits(SETTINGS.kbps)
        enc = getattr(self.sender, "_RTCRtpSender__encoder", None) if self.sender else None
        if enc is not None and hasattr(enc, "target_bitrate"):
            enc.target_bitrate = SETTINGS.kbps * 1000
        log.info("Качество: %dpx, %d fps, %d кбит/с", SETTINGS.width, SETTINGS.fps, SETTINGS.kbps)

    async def on_message(self, raw) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            return
        t = msg.get("t")
        if t == "cfg":
            self.apply_config(msg)
        elif t == "mon":
            cap = self.state.capturer
            cap.monitor_index = int(msg.get("i", 0)) % len(cap.monitors)
            self.send(self.hello())
        elif t == "ping":
            self.send({"t": "pong", "ts": msg.get("ts")})
        else:
            await self.state.input.run(msg)

    async def cursor_loop(self) -> None:
        last = None
        while not self.closed:
            await asyncio.sleep(1 / 30)
            if self.channel is None or self.channel.readyState != "open":
                continue
            pos = await self.state.input.call(self.state.input.cursor_norm)
            if pos != last:
                last = pos
                self.send({"t": "cur", "x": pos[0], "y": pos[1]} if pos else {"t": "cur"})

    async def start(self, offer: RTCSessionDescription) -> RTCSessionDescription:
        pc = self.pc

        @pc.on("datachannel")
        def on_datachannel(channel):
            self.channel = channel

            @channel.on("message")
            def on_message(message):
                asyncio.ensure_future(self.on_message(message))

            @channel.on("open")
            def on_open():
                self.send(self.hello())

            if channel.readyState == "open":
                self.send(self.hello())

        @pc.on("connectionstatechange")
        async def on_state():
            log.info("Соединение: %s", pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await self.close()

        await pc.setRemoteDescription(offer)
        self.sender = pc.addTrack(ScreenTrack(self.state.capturer))

        # H.264 первым: iPhone декодирует его аппаратно. VP8 — запасной вариант.
        caps = RTCRtpSender.getCapabilities("video").codecs
        prefs = [c for c in caps if c.mimeType == "video/H264"] + [
            c for c in caps if c.mimeType in ("video/VP8", "video/rtx")
        ]
        for tr in pc.getTransceivers():
            if tr.kind == "video":
                tr.setCodecPreferences(prefs)

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        self.tasks.append(asyncio.ensure_future(self.cursor_loop()))
        return pc.localDescription

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        for t in self.tasks:
            t.cancel()
        try:
            await self.state.input.call(self.state.input.release_all)
        except Exception:
            pass
        await self.pc.close()
        if self.state.session is self:
            self.state.session = None


# --------------------------------------------------------------------------
# HTTP-сервер
# --------------------------------------------------------------------------

class AppState:
    def __init__(self, token: str, capturer: Capturer) -> None:
        self.token = token
        self.capturer = capturer
        self.input = InputController(capturer)
        self.session: Session | None = None
        self.failures: dict[str, tuple[int, float]] = {}


def _client_ip(request: web.Request) -> str:
    return request.remote or "?"


async def handle_offer(request: web.Request) -> web.Response:
    state: AppState = request.app["state"]
    ip = _client_ip(request)

    fails, until = state.failures.get(ip, (0, 0.0))
    if time.monotonic() < until:
        return web.json_response({"error": "too_many_attempts"}, status=429)

    try:
        params = await request.json()
    except Exception:
        return web.json_response({"error": "bad_request"}, status=400)

    token = str(params.get("token", ""))
    if not hmac.compare_digest(token.encode(), state.token.encode()):
        fails += 1
        block = time.monotonic() + 60 if fails >= 5 else 0.0
        state.failures[ip] = (0 if block else fails, block)
        log.warning("Неверный код доступа от %s", ip)
        await asyncio.sleep(1.0)
        return web.json_response({"error": "bad_token"}, status=401)
    state.failures.pop(ip, None)

    # Одно подключение за раз: новое вытесняет старое (удобно при смене сети).
    if state.session is not None:
        await state.session.close()

    session = Session(state)
    state.session = session
    try:
        answer = await session.start(RTCSessionDescription(sdp=params["sdp"], type=params["type"]))
    except Exception as e:
        log.exception("Не удалось установить соединение")
        await session.close()
        return web.json_response({"error": str(e)}, status=500)

    log.info("Подключился телефон: %s", ip)
    return web.json_response({"sdp": answer.sdp, "type": answer.type})


@web.middleware
async def no_cache(request: web.Request, handler):
    resp = await handler(request)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def quiet_disconnects(app: web.Application) -> None:
    """Не печатать трассировки, когда телефон просто оборвал соединение."""
    loop = asyncio.get_running_loop()
    default = loop.get_exception_handler()

    def handler(loop, context):
        if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        if default:
            default(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


async def on_shutdown(app: web.Application) -> None:
    state: AppState = app["state"]
    if state.session is not None:
        await state.session.close()


# --------------------------------------------------------------------------
# Запуск
# --------------------------------------------------------------------------

def load_token(regenerate: bool) -> str:
    try:
        cfg = json.loads(CONFIG_FILE.read_text("utf-8"))
    except Exception:
        cfg = {}
    if regenerate or not cfg.get("token"):
        cfg["token"] = secrets.token_hex(4) + "-" + secrets.token_hex(4)
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2), "utf-8")
        try:
            os.chmod(CONFIG_FILE, 0o600)
        except Exception:
            pass
    return cfg["token"]


def local_addresses() -> list[tuple[str, str]]:
    """Список (ip, подпись) для подключения с телефона."""
    found: list[tuple[str, str]] = []
    try:
        import ifaddr

        for adapter in ifaddr.get_adapters():
            for ip in adapter.ips:
                if not isinstance(ip.ip, str):
                    continue
                addr = ipaddress.ip_address(ip.ip)
                if addr.is_loopback or addr.is_link_local:
                    continue
                if addr in ipaddress.ip_network("100.64.0.0/10"):
                    found.append((ip.ip, "Tailscale — работает откуда угодно"))
                elif addr.is_private:
                    found.append((ip.ip, f"локальная сеть ({adapter.nice_name})"))
    except Exception:
        pass
    if not found:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            found.append((s.getsockname()[0], "локальная сеть"))
            s.close()
        except Exception:
            pass
    # Tailscale первым
    found.sort(key=lambda x: 0 if x[1].startswith("Tailscale") else 1)
    seen, result = set(), []
    for ip, label in found:
        if ip not in seen and not ip.startswith("172.17."):
            seen.add(ip)
            result.append((ip, label))
    return result


def print_qr(url: str) -> None:
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except Exception:
        pass


def keep_awake():
    """Не даём ноутбуку уснуть, пока программа запущена."""
    if SYSTEM == "Windows":
        try:
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x1, 0x2
            ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
            )
        except Exception:
            pass
    elif SYSTEM == "Darwin":
        try:
            return subprocess.Popen(["caffeinate", "-dimsu", "-w", str(os.getpid())])
        except Exception:
            pass
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Пульт — управление ноутбуком с iPhone")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="0.0.0.0", help="адрес для прослушивания")
    parser.add_argument("--monitor", type=int, default=0, help="номер монитора (с 0)")
    parser.add_argument("--new-token", action="store_true", help="сгенерировать новый код доступа")
    parser.add_argument("--no-keep-awake", action="store_true", help="разрешить сон ноутбука")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
    )
    for noisy in ("aiortc", "aioice", "aiohttp.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if SYSTEM == "Windows":
        # В классической консоли щелчок мышью по окну включает «выделение»
        # и замораживает программу. Отключаем этот режим.
        try:
            k32 = ctypes.windll.kernel32
            handle = k32.GetStdHandle(-10)
            mode = ctypes.c_uint32()
            if k32.GetConsoleMode(handle, ctypes.byref(mode)):
                k32.SetConsoleMode(handle, (mode.value & ~0x0040) | 0x0080)
        except Exception:
            pass

    print("Запуск…", flush=True)
    _set_bitrate_limits(SETTINGS.kbps)
    token = load_token(args.new_token)
    capturer = Capturer(args.monitor)

    app = web.Application(middlewares=[no_cache])
    app["state"] = AppState(token, capturer)
    app.router.add_get("/", index)
    app.router.add_post("/offer", handle_offer)
    app.router.add_static("/", WEB_DIR, show_index=False)
    app.on_startup.append(quiet_disconnects)
    app.on_shutdown.append(on_shutdown)

    if not args.no_keep_awake:
        keep_awake()

    print()
    print("=" * 60)
    print("  Пульт запущен")
    print(f"  Код доступа: {token}")
    print("=" * 60)
    addrs = local_addresses()
    for ip, label in addrs:
        print(f"  http://{ip}:{args.port}/#t={token}   ({label})")
    if addrs:
        url = f"http://{addrs[0][0]}:{args.port}/#t={token}"
        print("\n  Наведите камеру iPhone на QR-код (адрес первой строки):")
        print_qr(url)
    print("  Остановить: Ctrl+C\n")

    web.run_app(app, host=args.host, port=args.port, print=None, access_log=None)


if __name__ == "__main__":
    main()
