#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gamepad Macro v19 (纯净安全版) — 铁拳8
  • 剔除所有引发 DLL 报错的第三方托盘库，恢复 v18 纯净环境。
  • [新增] 每3秒自动检测手柄防断连 (纯逻辑实现，无副作用)
  • [新增] 镜像开启时带有可拖拽的置顶悬浮窗标识 (Tkinter原生实现，默认关闭)
  • [新增] 强制结束选中窗口对应的进程功能
  • [优化] 支持宏源码修改自动保存，模板自定义增删。
  • [优化] 注释步骤保留原有数据；F1/F2录制新增提示音；手柄按键可用作全局热键。
  • [优化] 引入 winmm 1ms 睡眠精度；全局合并UI循环减轻Tkinter压力；原生API替换tasklist检测。
"""

import sys, os, time, json, copy, threading, traceback, subprocess
from license import LicenseManager, LicenseStatus
import ctypes
from ctypes import wintypes
import winsound

# 提升系统睡眠精度至 1ms，极大优化宏回放的准确度
try:
    if sys.platform == "win32":
        ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

def get_all_windows():
    """获取当前所有可见窗口的标题"""
    titles = []
    def enum_windows_proc(hwnd, lParam):
        if ctypes.windll.user32.IsWindowVisible(hwnd):
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value
                if title and title not in titles:
                    titles.append(title)
        return True
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
    ctypes.windll.user32.EnumWindows(EnumWindowsProc(enum_windows_proc), 0)
    return titles

# [B13修复] 已删除死代码 is_tekken_active()（全仓无调用，实际使用 _is_target_active）

# --- 原生进程枚举API (替代高耗能 tasklist) ---
class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(wintypes.ULONG)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_char * 260)
    ]

def is_process_running(process_name):
    """纯内存级原生检测进程存活，无子进程创建开销"""
    process_name = process_name.lower()
    if not process_name.endswith('.exe'):
        process_name += '.exe'
    TH32CS_SNAPPROCESS = 2
    kernel32 = ctypes.windll.kernel32
    hProcessSnap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if hProcessSnap == -1:
        return True # 获取失败当做存在，作兜底
    pe32 = PROCESSENTRY32()
    pe32.dwSize = ctypes.sizeof(PROCESSENTRY32)
    ret = kernel32.Process32First(hProcessSnap, ctypes.byref(pe32))
    found = False
    while ret:
        exe_name = pe32.szExeFile.decode('mbcs', 'ignore').lower()
        if exe_name == process_name:
            found = True
            break
        ret = kernel32.Process32Next(hProcessSnap, ctypes.byref(pe32))
    kernel32.CloseHandle(hProcessSnap)
    return found

def get_process_path(process_name):
    """获取指定进程名的可执行文件绝对路径"""
    process_name = process_name.lower()
    if not process_name.endswith('.exe'):
        process_name += '.exe'
    TH32CS_SNAPPROCESS = 2
    kernel32 = ctypes.windll.kernel32
    hProcessSnap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if hProcessSnap == -1: return ""
    pe32 = PROCESSENTRY32()
    pe32.dwSize = ctypes.sizeof(PROCESSENTRY32)
    ret = kernel32.Process32First(hProcessSnap, ctypes.byref(pe32))
    pid = 0
    while ret:
        exe_name = pe32.szExeFile.decode('mbcs', 'ignore').lower()
        if exe_name == process_name:
            pid = pe32.th32ProcessID
            break
        ret = kernel32.Process32Next(hProcessSnap, ctypes.byref(pe32))
    kernel32.CloseHandle(hProcessSnap)
    
    if not pid: return ""
    
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    hProcess = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if hProcess:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        if hasattr(kernel32, 'QueryFullProcessImageNameW'):
            success = kernel32.QueryFullProcessImageNameW(hProcess, 0, buf, ctypes.byref(size))
            kernel32.CloseHandle(hProcess)
            if success:
                return buf.value
    return ""

# 临时隐藏黑框兜底
if sys.platform == "win32":
    try:
        ctypes.windll.user32.ShowWindow(
            ctypes.windll.kernel32.GetConsoleWindow(), 0)
    except Exception:
        pass

def _fatal(msg):
    try:
        import tkinter as tk
        from tkinter import messagebox as mb
        r = tk.Tk(); r.withdraw(); mb.showerror("错误", msg); r.destroy()
    except Exception:
        print(msg, file=sys.stderr)
    sys.exit(1)

try:
    import pygame
except ImportError:
    _fatal("pip install pygame")
try:
    import vgamepad as vg
except ImportError:
    _fatal("pip install vgamepad + ViGEmBus")
try:
    import keyboard
except ImportError:
    _fatal("pip install keyboard (管理员)")

import tkinter as tk
from tkinter import ttk, messagebox, simpledialog, filedialog
try:
    import sv_ttk
except ImportError:
    sv_ttk = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILES_FILE = os.path.join(BASE_DIR, "profiles.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
POLL_MS = 2
AXIS_TH = 0.05

XBOX_BTN =[
    vg.XUSB_BUTTON.XUSB_GAMEPAD_A, vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_X, vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK, vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
    vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,
]
BTN_NAMES =["A", "B", "X", "Y", "LB", "RB", "Back", "Start", "L3", "R3", "Guide"]
ALL_BTNS = BTN_NAMES +["A+B", "A+X", "A+Y", "B+X", "B+Y", "X+Y", "LB+RB", "A+B+X", "A+B+Y"]
DP = {
    "U": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    "D": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    "L": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    "R": vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
}
DIR_MAP = {
    "↑上": (0, 1), "↓下": (0, -1), "←左": (-1, 0), "→右": (1, 0),
    "↗右上": (1, 1), "↘右下": (1, -1), "↖左上": (-1, 1), "↙左下": (-1, -1),
    "○中立": (0, 0),
}
DIR_LIST = list(DIR_MAP.keys())
DIR_V2N = {v: k for k, v in DIR_MAP.items()}

MIRROR_DIR = {
    (1, 0): (-1, 0), (-1, 0): (1, 0),
    (1, -1): (-1, -1), (-1, -1): (1, -1),
    (1, 1): (-1, 1), (-1, 1): (1, 1),
    (0, 1): (0, 1), (0, -1): (0, -1), (0, 0): (0, 0),
}
MIRROR_DIRNAME = {
    "→右": "←左", "←左": "→右", "↘右下": "↙左下", "↙左下": "↘右下",
    "↗右上": "↖左上", "↖左上": "↗右上", "↑上": "↑上", "↓下": "↓下",
    "○中立": "○中立",
}

HOTKEY_SLOTS =[
    {"id": "slot1", "label": "热键1", "default_name": "space", "default_scan": 57},
    {"id": "slot2", "label": "热键2", "default_name": "left", "default_scan": 75},
    {"id": "slot3", "label": "热键3", "default_name": "down", "default_scan": 80},
    {"id": "slot4", "label": "热键4", "default_name": "right", "default_scan": 77},
]
DEFAULT_MIRROR_KEY = {"type": "keyboard", "name": "num 0", "scan_code": 82}

# ─── 工具函数 ───
def safe_pump():
    try: pygame.event.pump()
    except Exception: pass

def btn_n2i(name):
    for i, n in enumerate(BTN_NAMES):
        if n.upper() == name.strip().upper(): return i
    try: return int(name)
    except Exception: return 0

def btn_ids(s):
    return[btn_n2i(b) for b in s.split("+")]

def new_step(stype, **kw):
    s = {"type": stype}
    if stype == "wait": s["delay"] = kw.get("delay", 0)
    elif stype == "dir": s["dir"] = kw.get("dir", "○中立")
    elif stype in ("press", "release"): s["btn"] = kw.get("btn", "A")
    elif stype == "tap":
        s["btn"] = kw.get("btn", "A")
        s["rep"] = kw.get("rep", 1)
        s["dur"] = kw.get("dur", 50)
        s["gap"] = kw.get("gap", 30)
    elif stype == "comment": s["text"] = kw.get("text", "")
    return s

def normalize_steps(steps):
    out = []
    for s in steps:
        d = int(s.get("delay", 0)) # 强制取整
        tp = s.get("type", "wait")
        if d > 0 and tp != "wait":
            out.append({"type": "wait", "delay": d})
            # [优化]: dict 的平铺结构只需浅拷贝即可，剔除极度耗时的 deepcopy
            ns = s.copy()
            ns.pop("delay", None)
            out.append(ns)
        elif tp == "wait":
            if d > 0: # 绝对过滤掉 0 延迟
                out.append({"type": "wait", "delay": d})
        else:
            # [优化]: 同上
            ns = s.copy()
            ns.pop("delay", None)
            out.append(ns)
    return out

def step_display(s, idx):
    tp = s.get("type", "?")
    prefix = f"{idx + 1:3d}.  "
    if tp == "wait": return f"{prefix}延迟 {s.get('delay', 0):.0f}ms"
    elif tp == "press": return f"{prefix}按下 {s.get('btn', 'A')}"
    elif tp == "release": return f"{prefix}松开 {s.get('btn', 'A')}"
    elif tp == "dir": return f"{prefix}方向 {s.get('dir', '○中立')}"
    elif tp == "tap": return f"{prefix}连按 {s.get('btn', 'A')} ×{s.get('rep', 1)}  ({s.get('dur', 50)}/{s.get('gap', 30)}ms)"
    elif tp == "comment": return f"{prefix}// {s.get('text', '')}"
    return f"{prefix}{tp}"

def steps_to_events(steps, mirror=False):
    ev =[]
    t = 0.0
    for s in steps:
        tp = s.get("type", "wait")
        if tp == "comment": continue
        if tp == "wait":
            t += s.get("delay", 0)
            continue
        t += s.get("delay", 0)
        if tp == "dir":
            dn = s.get("dir", "○中立")
            if mirror: dn = MIRROR_DIRNAME.get(dn, dn)
            dv = DIR_MAP.get(dn, (0, 0))
            ev.append({"t": round(t, 1), "type": "hat", "id": 0, "val": list(dv)})
        elif tp in ("press", "release"):
            v = 1 if tp == "press" else 0
            for bid in btn_ids(s.get("btn", "A")):
                ev.append({"t": round(t, 1), "type": "btn", "id": bid, "val": v})
        elif tp == "tap":
            dur = s.get("dur", 50)
            gap = s.get("gap", 30)
            for r2 in range(s.get("rep", 1)):
                if r2 > 0: t += gap
                for bid in btn_ids(s.get("btn", "A")):
                    ev.append({"t": round(t, 1), "type": "btn", "id": bid, "val": 1})
                t += dur
                for bid in btn_ids(s.get("btn", "A")):
                    ev.append({"t": round(t, 1), "type": "btn", "id": bid, "val": 0})
    return ev

def events_to_steps(events):
    ss = []
    pt = 0.0
    for e in events:
        t = e.get("t", 0.0)
        d = int(round(t - pt)) # 彻底抹平浮点数带来的 0ms 幽灵
        if d > 0:
            ss.append({"type": "wait", "delay": d})
        if e["type"] == "btn":
            nm = BTN_NAMES[e["id"]] if 0 <= e["id"] < len(BTN_NAMES) else f"BTN{e['id']}"
            tp2 = "press" if e["val"] else "release"
            ss.append({"type": tp2, "btn": nm})
        elif e["type"] == "hat":
            dn = DIR_V2N.get(tuple(e["val"]), "○中立")
            ss.append({"type": "dir", "dir": dn})
        pt = t
    return ss

# ─── 步骤编辑弹窗 ───
class StepEditDialog(tk.Toplevel):
    def __init__(self, parent, step, title="编辑步骤"):
        super().__init__(parent)
        self.title(title)
        self.resizable(False, False)
        self.grab_set()
        self.result = None
        self.step = copy.deepcopy(step)

        main = ttk.Frame(self, padding=12)
        main.pack(fill="both", expand=True)

        r0 = ttk.Frame(main)
        r0.pack(fill="x", pady=(0, 8))
        ttk.Label(r0, text="类型:", width=6).pack(side="left")
        self.var_type = tk.StringVar(value=step.get("type", "wait"))
        cmb_type = ttk.Combobox(r0, textvariable=self.var_type, state="readonly", width=12,
                                 values=["wait", "press", "release", "dir", "tap", "comment"])
        cmb_type.pack(side="left", padx=4)
        cmb_type.bind("<<ComboboxSelected>>", lambda _: self._refresh())

        self.dyn = ttk.Frame(main)
        self.dyn.pack(fill="x", pady=4)

        bf = ttk.Frame(main)
        bf.pack(fill="x", pady=(8, 0))
        ttk.Button(bf, text="确定", command=self._ok, width=10).pack(side="left", padx=4)
        ttk.Button(bf, text="取消", command=self.destroy, width=10).pack(side="left", padx=4)

        self._refresh()
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.transient(parent)
        self.update_idletasks()
        pw = parent.winfo_rootx() + parent.winfo_width() // 2
        ph = parent.winfo_rooty() + parent.winfo_height() // 2
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{pw - w // 2}+{ph - h // 2}")

    def _refresh(self):
        new_tp = self.var_type.get()
        old_tp = getattr(self, '_last_tp', self.step.get("type", "wait"))
        
        # 自动打包上个阶段状态的数据以便保留
        auto_text = ""
        if new_tp == "comment" and old_tp != "comment":
            try:
                s_temp = {"type": old_tp}
                if old_tp == "wait": s_temp["delay"] = max(0, int(self.var_delay.get()))
                elif old_tp in ("press", "release"): s_temp["btn"] = self.var_btn.get().strip() or "A"
                elif old_tp == "dir": s_temp["dir"] = self.var_dir.get()
                elif old_tp == "tap":
                    s_temp["btn"] = self.var_btn.get().strip() or "A"
                    s_temp["rep"] = max(1, int(self.var_rep.get()))
                    s_temp["dur"] = max(1, int(self.var_dur.get()))
                    s_temp["gap"] = max(0, int(self.var_gap.get()))
                auto_text = json.dumps(s_temp, ensure_ascii=False)
            except Exception:
                auto_text = json.dumps(self.step, ensure_ascii=False)
                
        self._last_tp = new_tp

        for w in self.dyn.winfo_children(): w.destroy()
        tp = self.var_type.get()
        if tp == "wait":
            r = ttk.Frame(self.dyn)
            r.pack(fill="x")
            ttk.Label(r, text="延迟:", width=6).pack(side="left")
            self.var_delay = tk.StringVar(value=str(int(self.step.get("delay", 0))))
            ttk.Spinbox(r, from_=0, to=99999, width=8, textvariable=self.var_delay).pack(side="left", padx=4)
            ttk.Label(r, text="ms").pack(side="left")
        elif tp in ("press", "release"):
            r = ttk.Frame(self.dyn)
            r.pack(fill="x")
            ttk.Label(r, text="按键:", width=6).pack(side="left")
            # [B3修复] 编辑已有步骤时保留原按键；新建步骤（无 btn 字段）才默认 A
            self.var_btn = tk.StringVar(value=self.step.get("btn", "A"))
            cb = ttk.Combobox(r, textvariable=self.var_btn, width=12, values=ALL_BTNS)
            cb.pack(side="left", padx=4)
            ttk.Label(r, text="(可手动输入组合如 A+B)").pack(side="left")
        elif tp == "dir":
            r = ttk.Frame(self.dyn)
            r.pack(fill="x")
            ttk.Label(r, text="方向:", width=6).pack(side="left")
            self.var_dir = tk.StringVar(value=self.step.get("dir", "○中立"))
            ttk.Combobox(r, textvariable=self.var_dir, state="readonly", width=12, values=DIR_LIST).pack(side="left", padx=4)
        elif tp == "tap":
            r1 = ttk.Frame(self.dyn)
            r1.pack(fill="x")
            ttk.Label(r1, text="按键:", width=6).pack(side="left")
            # [B3修复] 编辑已有步骤时保留原按键；新建步骤（无 btn 字段）才默认 A
            self.var_btn = tk.StringVar(value=self.step.get("btn", "A"))
            ttk.Combobox(r1, textvariable=self.var_btn, width=12, values=ALL_BTNS).pack(side="left", padx=4)
            r2 = ttk.Frame(self.dyn)
            r2.pack(fill="x", pady=2)
            ttk.Label(r2, text="次数:", width=6).pack(side="left")
            self.var_rep = tk.StringVar(value=str(self.step.get("rep", 1)))
            ttk.Spinbox(r2, from_=1, to=99, width=4, textvariable=self.var_rep).pack(side="left", padx=4)
            ttk.Label(r2, text="  按住:").pack(side="left")
            self.var_dur = tk.StringVar(value=str(self.step.get("dur", 50)))
            ttk.Spinbox(r2, from_=1, to=9999, width=5, textvariable=self.var_dur).pack(side="left", padx=2)
            ttk.Label(r2, text="ms  间隔:").pack(side="left")
            self.var_gap = tk.StringVar(value=str(self.step.get("gap", 30)))
            ttk.Spinbox(r2, from_=0, to=9999, width=5, textvariable=self.var_gap).pack(side="left", padx=2)
            ttk.Label(r2, text="ms").pack(side="left")
        elif tp == "comment":
            r = ttk.Frame(self.dyn)
            r.pack(fill="x")
            ttk.Label(r, text="注释:", width=6).pack(side="left")
            val = auto_text if auto_text else self.step.get("text", "")
            self.var_text = tk.StringVar(value=val)
            ttk.Entry(r, textvariable=self.var_text, width=40).pack(side="left", padx=4)

    def _ok(self):
        tp = self.var_type.get()
        s = {"type": tp}
        try:
            if tp == "wait": s["delay"] = max(0, int(self.var_delay.get()))
            elif tp in ("press", "release"): s["btn"] = self.var_btn.get().strip() or "A"
            elif tp == "dir": s["dir"] = self.var_dir.get()
            elif tp == "tap":
                s["btn"] = self.var_btn.get().strip() or "A"
                s["rep"] = max(1, int(self.var_rep.get()))
                s["dur"] = max(1, int(self.var_dur.get()))
                s["gap"] = max(0, int(self.var_gap.get()))
            elif tp == "comment": s["text"] = self.var_text.get()
        except ValueError:
            messagebox.showwarning("输入错误", "数值格式错误", parent=self)
            return
        self.result = s
        self.destroy()

# ─── 主应用 ───
class App:
    def __init__(self, root):
        self.root = root
        root.title("Gamepad Macro v19 (商业版) — 铁拳8")
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.alive = True
        self.tick_count = 0
        
        self.license_mgr = LicenseManager(BASE_DIR)
        self.license_mgr.set_status_callback(self._on_license_status_change)
        self.license_mgr.initialize()

        self.play_joy = None
        self.play_guid = None
        self.play_nb = 0
        self.play_prev_b = {}
        self.play_prev_h_play = {}
        self.play_cur_b = {}
        self.rec_joy = None
        self.rec_guid = None
        self.rec_nb = self.rec_na = self.rec_nh = 0
        self.rec_prev_b = {}
        self.rec_prev_a = {}
        self.rec_prev_h = {}
        self.rec_cur_b = {}
        self.rec_cur_a = {}
        self.rec_cur_h = {}
        self.vpad = None
        self.recording = False
        self.rec_buf =[]
        self.rec_t0 = 0.0
        self.macros =[]
        self.active_idx = -1
        self.playing = False
        self.editing_idx = -1
        self.trigger_btn = -1
        self.trigger_macro_idx = -1
        self.binding = False

        self.hotkey_binds = {s["id"]: -1 for s in HOTKEY_SLOTS}
        self.hotkey_keys = {s["id"]: {"type": "keyboard", "name": s["default_name"], "scan_code": s["default_scan"]} for s in HOTKEY_SLOTS}
        self.mirror_key = copy.deepcopy(DEFAULT_MIRROR_KEY)
        self.profiles = []
        self.active_profile_idx = -1
        
        self.mirror = False
        self.sound_enabled = True
        self.target_window = "TEKKEN 8"

        self.monitor_on = False
        self.win_geometry = "1060x900"
        self._detecting_slot = None
        self._detect_kb_flag = False
        self.recycle_bin =[]

        os.environ["SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS"] = "1"
        os.environ["SDL_VIDEODRIVER"] = "dummy"
        try:
            pygame.init()
            try: pygame.display.set_mode((1, 1))
            except Exception: pass
        except Exception as e: _fatal(f"pygame:\n{e}")

        try:
            self.vpad = vg.VX360Gamepad()
            self.vpad.reset()
            self.vpad.update()
        except Exception as e:
            _fatal(f"虚拟手柄:\n{e}")

        self._load_cfg()
        self._load_profiles()
        self._build_gui()

        try: root.geometry(self.win_geometry)
        except Exception: root.geometry("1060x900")
        root.update_idletasks()
        self._geo_save_id = None
        root.bind("<Configure>", self._on_win_configure)
        root.bind_all("<Button-1>", self._on_mouse_click_cancel_detect, add="+")
        root.bind_all("<Button-3>", self._on_mouse_click_cancel_detect, add="+")

        self.scan_pads()
        self._register_hotkeys()
        
        # 统一启动后台与前端循环
        threading.Thread(target=self._poll_loop, daemon=True).start()
        self.root.after(100, self._main_tick)
        
        self._sync_scroll_lock()

    def _main_tick(self):
        """统一的UI线程定时器调度中心，100ms 一次，减少Tkinter消息堆积"""
        if not getattr(self, "alive", False): return
        self.tick_count += 1
        
        # 1. (每100ms) 刷新监控 UI 
        try:
            if self.monitor_on:
                parts =[]
                if self.play_joy and self.play_cur_b:
                    parts.append("🕹 " + " ".join(f"[B{i}██]" if self.play_cur_b[i] else f" B{i}··" for i in sorted(self.play_cur_b)))
                if self.rec_joy and self.rec_cur_b:
                    parts.append("🎮 " + " ".join(f"[B{i}██]" if self.rec_cur_b[i] else f" B{i}··" for i in sorted(self.rec_cur_b)))
                self.lbl_live.config(text="\n".join(parts) if parts else "(选设备)")
        except Exception: pass

        # 2. (每1000ms / 1秒) 免费计费器更新 & PID显示更新
        if self.tick_count % 10 == 0:
            try:
                if getattr(self.license_mgr.free_timer, "_running", False):
                    if self.license_mgr.get_status() == LicenseStatus.FREE:
                        self._on_license_status_change(LicenseStatus.FREE, "")
                        if self.license_mgr.free_timer.is_exhausted():
                            self._on_license_status_change(LicenseStatus.FREE_EXHAUSTED, "")
            except Exception: pass

            try:
                if hasattr(self, 'lbl_pid'):
                    pid = self._get_target_pid()
                    self.lbl_pid.config(text=f"PID: {pid}" if pid > 0 else "PID: --")
            except Exception: pass

        # 3. (每3000ms / 3秒) 摇杆自动扫描
        # [B2修复] 录制/回放进行中跳过自动扫描，避免 scan_pads() 销毁正在使用的手柄导致录制被中断
        if self.tick_count % 30 == 0:
            if self.play_joy is None and not self.recording and not self.playing:
                self.scan_pads()

        # 4. (每5000ms / 5秒) 副进程存活检测
        if self.tick_count % 50 == 0:
            sec_proc = getattr(self, 'var_sec_proc', None) and self.var_sec_proc.get().strip() or getattr(self, 'sec_process', "steam")
            use_sec = getattr(self, 'var_use_sec_proc', None) and self.var_use_sec_proc.get()
            
            # 自动探测并记录副进程(如Steam)的完整路径
            if sec_proc:
                path = get_process_path(sec_proc)
                if path and getattr(self, "sec_process_path", "") != path:
                    self.sec_process_path = path
                    self._save_c()

            if getattr(self, "target_window", ""):
                wins = get_all_windows()
                primary_alive = any(self.target_window in w for w in wins)
                # 只有在勾选了"作为兜底"并且主目标不存在时，才会执行双重消失检测
                if use_sec and not primary_alive:
                    if sec_proc:
                        if not is_process_running(sec_proc):
                            # [B5修复] 不再静默关闭整个程序，改为弹确认框，避免误伤
                            self._maybe_sec_exit()

        self.root.after(100, self._main_tick)

    def _on_win_configure(self, event):
        if event.widget is not self.root: return
        if self._geo_save_id: self.root.after_cancel(self._geo_save_id)
        self._geo_save_id = self.root.after(500, self._save_geometry)

    def _maybe_sec_exit(self):
        """[B5修复] 兜底退出前先确认，避免静默关闭整个程序（仅提示一次）。"""
        if getattr(self, "_sec_exit_asked", False): return
        self._sec_exit_asked = True
        try:
            if messagebox.askyesno("退出确认",
                                   "检测到目标窗口与副进程均已消失。\n是否退出 Gamepad Macro？",
                                   parent=self.root):
                self.on_close()
            else:
                # 用户取消：停止当前回放，但不退出主程序
                self._st("⚠ 兜底检测：已取消退出")
        except Exception:
            pass

    def _save_geometry(self):
        try:
            geo = self.root.geometry()
            if geo and "+" in geo:
                self.win_geometry = geo
                self._save_c()
        except Exception: pass

    # ── 热键 ──
    def _register_hotkeys(self):
        try: keyboard.unhook_all()
        except Exception: pass
        try:
            keyboard.on_press_key("f1", lambda _: self.root.after(0, self.rec_start), suppress=False)
            keyboard.on_press_key("f2", lambda _: self.root.after(0, self.rec_stop), suppress=False)
            for slot in HOTKEY_SLOTS:
                ki = self.hotkey_keys.get(slot["id"])
                if not ki: continue
                if ki.get("type", "keyboard") == "keyboard":
                    sc = ki.get("scan_code", slot["default_scan"])
                    keyboard.on_press_key(sc, lambda _, sid=slot["id"]: self._on_hotkey(sid), suppress=False)
            msc = self.mirror_key
            if msc and msc.get("type", "keyboard") == "keyboard":
                sc = msc.get("scan_code")
                if sc is not None:
                    keyboard.on_press_key(sc, lambda _: self.root.after(0, self._toggle_mirror), suppress=False)
        except Exception as e:
            self._st(f"⚠ 热键:{e}")

    def _refresh_windows(self):
        wins = get_all_windows()
        if self.target_window and self.target_window not in wins:
            wins.insert(0, self.target_window)
        self.cmb_windows["values"] = wins
        self.var_target_win.set(self.target_window)

    def _get_target_pid(self):
        if not hasattr(self, 'var_target_win'): return 0
        target = self.var_target_win.get().strip()
        if not target: return 0
        found_hwnd = 0
        def enum_windows_proc(hwnd, lParam):
            nonlocal found_hwnd
            if ctypes.windll.user32.IsWindowVisible(hwnd):
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if target == title or target in title:
                        found_hwnd = hwnd
                        return False
            return True
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
        ctypes.windll.user32.EnumWindows(EnumWindowsProc(enum_windows_proc), 0)
        if not found_hwnd: return 0
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(found_hwnd, ctypes.byref(pid))
        return pid.value

    def _on_target_win_sel(self, _=None):
        self.target_window = self.var_target_win.get().strip()
        self._save_c()
        self._st(f"锁定目标窗口: {self.target_window}")

    def _kill_target_process(self):
            """强制结束下拉框所选窗口对应的进程 (优化版：支持带 ™ 等特殊字符的模糊匹配)"""
            target = self.var_target_win.get().strip()
            if not target:
                messagebox.showinfo("提示", "当前没有选定任何目标窗口", parent=self.root)
                return
            found_hwnd = 0
            # 定义一个内部回调函数，遍历所有窗口找句柄
            def enum_windows_proc(hwnd, lParam):
                nonlocal found_hwnd
                if ctypes.windll.user32.IsWindowVisible(hwnd):
                    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                    if length > 0:
                        buf = ctypes.create_unicode_buffer(length + 1)
                        ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                        title = buf.value
                        # 使用 Python 层面的包含(in)或全等比对，完美规避 C API 的 ™ 字符坑
                        if target == title or target in title:
                            found_hwnd = hwnd
                            return False # 找到了，返回 False 终止遍历
                return True # 没找到，继续遍历
            EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int))
            ctypes.windll.user32.EnumWindows(EnumWindowsProc(enum_windows_proc), 0)
            if not found_hwnd:
                messagebox.showinfo("提示", f"未找到标题包含 '{target}' 的活跃窗口，进程可能已退出。", parent=self.root)
                return
            pid = ctypes.c_ulong()
            ctypes.windll.user32.GetWindowThreadProcessId(found_hwnd, ctypes.byref(pid))
            if pid.value > 0:
                try:
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid.value)], creationflags=0x08000000)
                    self._st(f"✅ 已强制终止进程 (PID: {pid.value})")
                    self.root.after(1500, self._refresh_windows)
                except Exception as e:
                    messagebox.showerror("结束进程失败", str(e), parent=self.root)
            else:
                messagebox.showerror("错误", "无法提取该窗口的进程ID。", parent=self.root)

    def _is_target_active(self):
        if not self.target_window: return False
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        if not hwnd: return False
        length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
        active_title = buf.value
        # 已移除 Gamepad Macro 的特权判定，必须是所选目标窗口在最前面才能触发
        return self.target_window in active_title

    def _start_sec_process(self):
        proc_name = self.var_sec_proc.get().strip()
        if not proc_name: return
        
        current_path = get_process_path(proc_name)
        if current_path:
            self.sec_process_path = current_path
            self._save_c()
            
        saved_path = getattr(self, "sec_process_path", "")
        if not saved_path or not os.path.exists(saved_path):
            messagebox.showerror("提示", f"未找到 '{proc_name}' 的路径！\n请先手动启动一次，软件会自动记录位置。", parent=self.root)
            return
            
        try:
            subprocess.Popen([saved_path])
            self._st(f"🚀 已启动: {proc_name}")
        except Exception as e:
            messagebox.showerror("启动失败", str(e), parent=self.root)

    def _on_hotkey(self, slot_id):
        if not self._is_target_active(): return
        idx = self.hotkey_binds.get(slot_id, -1)
        if 0 <= idx < len(self.macros):
            self._play_macro(idx)

    def _sync_scroll_lock(self):
        try:
            state = ctypes.windll.user32.GetKeyState(0x91) & 0x0001
            if bool(state) != self.mirror:
                ctypes.windll.user32.keybd_event(0x91, 0, 0, 0)
                ctypes.windll.user32.keybd_event(0x91, 0, 2, 0)
        except Exception: pass

    def _toggle_mirror(self):
        # 如果焦点不在所选目标窗口，则屏蔽镜像热键触发
        if not self._is_target_active(): return
        self.mirror = not self.mirror
        state = "开启 🔄" if self.mirror else "关闭"
        self.lbl_mirror.config(text=f"镜像: {state}", foreground="red" if self.mirror else "gray")
        self._st(f"镜像翻转: {state}")
        self._sync_scroll_lock()
        
        def _feedback():
            try:
                if self.play_joy:
                    if self.mirror:
                        self.play_joy.rumble(0.0, 0.5, 150)
                        time.sleep(0.25)
                        self.play_joy.rumble(0.0, 0.5, 150)
                    else:
                        self.play_joy.rumble(0.5, 0.0, 300)
            except Exception: pass
            if self.sound_enabled:
                if self.mirror:
                    winsound.Beep(600, 120)
                    time.sleep(0.02)
                    winsound.Beep(800, 120)
                else:
                    winsound.Beep(800, 120)
                    time.sleep(0.02)
                    winsound.Beep(600, 120)
                
        threading.Thread(target=_feedback, daemon=True).start()
        self._save_c()

    def _on_sound_toggle(self):
        self.sound_enabled = self.var_sound.get()
        self._save_c()

    # ── 按键检测 ──
    def _start_detect_key(self, slot_id):
        if self._detecting_slot is not None: return
        self._detecting_slot = slot_id
        if slot_id == "mirror": self.btn_mirror_det.config(text="⏳ 请按键...", state="disabled")
        elif slot_id in self.hotkey_wgt: self.hotkey_wgt[slot_id]["btn_det"].config(text="⏳ 请按键...", state="disabled")
        self._st("⏳ 请按下你要绑定的 键盘或手柄 按键...")
        
        self._detect_kb_flag = True

        def _det_kb():
            try:
                while self._detect_kb_flag:
                    evt = keyboard.read_event(suppress=False)
                    if evt.event_type == "down":
                        if not self._detect_kb_flag: break
                        self._detect_kb_flag = False
                        self.root.after(0, lambda: self._finish_detect(slot_id, "keyboard", evt.name or f"scan{evt.scan_code}", evt.scan_code))
                        break
            except Exception as ex:
                if self._detect_kb_flag:
                    self.root.after(0, lambda: self._cancel_detect(slot_id, str(ex)))
                    
        threading.Thread(target=_det_kb, daemon=True).start()

    def _finish_detect(self, slot_id, device_type, name, scan_code):
        self._detecting_slot = None
        self._detect_kb_flag = False
        ki = {"type": device_type, "name": name, "scan_code": scan_code}
        
        if device_type == "joystick":
            disp = f"{name} (joy)"
        else:
            disp = f"{name}  (scan:{scan_code})"
            
        if slot_id == "mirror":
            self.mirror_key = ki
            self.lbl_mirror_key.config(text=disp, foreground="green")
            self.btn_mirror_det.config(text="设置按键", state="normal")
        elif slot_id in self.hotkey_wgt:
            self.hotkey_keys[slot_id] = ki
            hw = self.hotkey_wgt[slot_id]
            hw["lbl_key"].config(text=disp, foreground="green")
            hw["btn_det"].config(text="设置按键", state="normal")
            
        self._register_hotkeys()
        self._save_c()
        self._st(f"✅ 已绑定: {disp}")

    def _cancel_detect(self, slot_id, err):
        self._detecting_slot = None
        self._detect_kb_flag = False
        if slot_id == "mirror": self.btn_mirror_det.config(text="设置按键", state="normal")
        elif slot_id in self.hotkey_wgt: self.hotkey_wgt[slot_id]["btn_det"].config(text="设置按键", state="normal")
        self._st(f"⚠ 检测失败: {err}")

    def _on_mouse_click_cancel_detect(self, event=None):
        if self._detecting_slot is not None:
            self._cancel_detect(self._detecting_slot, "已取消 (鼠标点击)")
        if getattr(self, "binding", False):
            self.binding = False
            self._apply_tb()
            self._st("⚠ 检测失败: 已取消 (鼠标点击)")

    # ──────── 授权 GUI ────────
    def _build_license_bar(self, parent):
        self.f_license = ttk.Frame(parent)
        # 注意：这里去掉了原本的 pack()，改为让外部使用 place() 悬浮定位
        
        # 1. 输入CDK按钮放在最左边
        self.btn_license_act = ttk.Button(self.f_license, text="输入CDK激活", command=self._show_activation_dialog)
        self.btn_license_act.pack(side="left", padx=(0, 8))
        
        # 2. 授权状态图标放在按钮右侧
        self.lbl_license_icon = ttk.Label(self.f_license, text="🔑")
        self.lbl_license_icon.pack(side="left")
        
        # 3. 授权状态文字放在最右侧
        self.lbl_license_text = ttk.Label(self.f_license, text="授权状态检测中...", font=("Microsoft YaHei UI", 9, "bold"))
        self.lbl_license_text.pack(side="left", padx=(4, 0))

    def _show_activation_dialog(self):
        cdk = simpledialog.askstring("激活", "请输入CDK码:", parent=self.root)
        if cdk:
            success, msg = self.license_mgr.activate_cdk(cdk)
            if success:
                messagebox.showinfo("激活成功", msg, parent=self.root)
            else:
                messagebox.showerror("激活失败", msg, parent=self.root)

    def _on_license_status_change(self, status, info):
        def _update():
            if not getattr(self, "alive", False): return
            # [O4优化] 状态未变化时跳过 UI 重绘，减少 Tk 抖动
            if getattr(self, "_last_ls_status", None) == status: return
            self._last_ls_status = status
            if status == LicenseStatus.PAID:
                self.lbl_license_icon.config(text="✅")
                self.lbl_license_text.config(text=f"已授权 ({self.license_mgr.get_card_type_display()}) | 到期: {self.license_mgr.get_expires_display()}", foreground="green")
                self.btn_license_act.config(text="解绑设备", command=self._deactivate)
            elif status == LicenseStatus.FREE:
                self.lbl_license_icon.config(text="🆓")
                self.lbl_license_text.config(text=f"免费模式 | 今日剩余: {self.license_mgr.get_free_remaining_display()} {info}", foreground="#f59e0b")
                self.btn_license_act.config(text="输入CDK激活", command=self._show_activation_dialog)
            elif status == LicenseStatus.FREE_EXHAUSTED:
                self.lbl_license_icon.config(text="⏰")
                self.lbl_license_text.config(text="今日免费额度已用完 (明日0点重置)", foreground="red")
                self.btn_license_act.config(text="输入CDK激活", command=self._show_activation_dialog)
            elif status == LicenseStatus.EXPIRED:
                self.lbl_license_icon.config(text="⏰")
                self.lbl_license_text.config(text="CDK 已过期", foreground="red")
                self.btn_license_act.config(text="输入新CDK激活", command=self._show_activation_dialog)
            elif status == LicenseStatus.REVOKED:
                self.lbl_license_icon.config(text="🔴")
                self.lbl_license_text.config(text="CDK 已被作废", foreground="red")
                self.btn_license_act.config(text="输入新CDK激活", command=self._show_activation_dialog)
        try:
            self.root.after(0, _update)
        except Exception:
            pass

    def _deactivate(self):
        if messagebox.askyesno("解绑设备", "解绑后将退回免费模式（如果CDK支持多设备且未满可以再换机登录）。\n确定要注销当前授权吗？"):
            self.license_mgr.deactivate()

    # ──────── GUI ────────
    def _build_gui(self):
        # 先生成底部的 Notebook 标签页结构
        self.tabs = ttk.Notebook(self.root)
        self.tabs.pack(fill="both", expand=True, padx=6, pady=4)
        t1 = ttk.Frame(self.tabs)
        self.tabs.add(t1, text="  🎮 主界面  ")
        self._build_main(t1)
        t2 = ttk.Frame(self.tabs)
        self.tabs.add(t2, text="  ✏ 宏编辑器  ")
        self._build_editor(t2)
        t3 = ttk.Frame(self.tabs)
        self.tabs.add(t3, text="  📊 监控  ")
        self._build_monitor(t3)
        
        # 【布局黑科技】：生成授权模块，并悬浮在窗口右上角！
        # 这样它就会完美出现在"主界面/宏编辑器"标签的同行最右侧，两边分布！
        self._build_license_bar(self.root)
        self.f_license.place(relx=1.0, y=6, x=-12, anchor="ne")

        # 底部状态栏
        st_frame = ttk.Frame(self.root)
        st_frame.pack(fill="x", padx=6, pady=(0, 4))
        self.lbl_pid = ttk.Label(st_frame, text="PID: --", relief="sunken", anchor="center", width=12)
        self.lbl_pid.pack(side="left", padx=(0, 4))
        self.lbl_st = ttk.Label(st_frame, text="就绪", relief="sunken", anchor="w")
        self.lbl_st.pack(side="left", fill="x", expand=True)
        self._ref_list()

    def _build_main(self, p):
        # 引入 PanedWindow，允许上下拖拽改变区域高度
        self.main_pw = ttk.PanedWindow(p, orient="vertical")
        self.main_pw.pack(fill="both", expand=True)
        self.top_pane = ttk.Frame(self.main_pw)
        self.main_pw.add(self.top_pane, weight=0)
        self.bottom_pane = ttk.Frame(self.main_pw)
        self.main_pw.add(self.bottom_pane, weight=1)

        f0 = ttk.LabelFrame(self.top_pane, text="★ 目标生效窗口 (仅当选中窗口在最前方时，宏才生效)")
        f0.pack(fill="x", padx=6, pady=(4, 2))
        r0 = ttk.Frame(f0)
        r0.pack(fill="x", padx=4, pady=2)
        ttk.Button(r0, text="🔄 刷新列表", command=self._refresh_windows).pack(side="left", padx=4)
        self.var_target_win = tk.StringVar(value=self.target_window)
        self.cmb_windows = ttk.Combobox(r0, textvariable=self.var_target_win, state="normal", width=45)
        self.cmb_windows.pack(side="left", padx=4, fill="x", expand=True)
        self.cmb_windows.bind("<<ComboboxSelected>>", self._on_target_win_sel)
        
        ttk.Button(r0, text="💾 保存进程", command=self._on_target_win_sel).pack(side="left", padx=4)
        # ★ 新增：结束进程按钮
        btn_kill = ttk.Button(r0, text="✕ 结束进程", command=self._kill_target_process)
        btn_kill.pack(side="left", padx=4)
        
        self._refresh_windows()

        r_sec = ttk.Frame(f0)
        r_sec.pack(fill="x", padx=4, pady=(0, 2))
        ttk.Label(r_sec, text="副进程(不带exe):").pack(side="left", padx=4)
        self.var_sec_proc = tk.StringVar(value=getattr(self, 'sec_process', "steam"))
        esec = ttk.Entry(r_sec, textvariable=self.var_sec_proc, width=15)
        esec.pack(side="left", padx=4)
        esec.bind("<FocusOut>", lambda _: self._save_c())
        
        # 增加勾选框：是否作为兜底进程
        self.var_use_sec_proc = tk.BooleanVar(value=getattr(self, 'use_sec_proc', True))
        chk_sec = ttk.Checkbutton(r_sec, text="作为兜底(目标与副进程均消失时退出)", variable=self.var_use_sec_proc, command=self._save_c)
        chk_sec.pack(side="left", padx=4)
        
        btn_start_sec = ttk.Button(r_sec, text="▶ 启动该进程", command=self._start_sec_process)
        btn_start_sec.pack(side="left", padx=8)

        # 取消 LabelFrame 边框，改为普通 Frame，标题与按钮同行以节约空间！
        f1 = ttk.Frame(self.top_pane)
        f1.pack(fill="x", padx=6, pady=(4, 2))
        bf1 = ttk.Frame(f1)
        bf1.pack(fill="x", padx=4, pady=2)
        
        # 字体加大，对齐3和5的大小，不再显小
        ttk.Label(bf1, text="① 设备").pack(side="left", padx=(0, 10))
        ttk.Button(bf1, text="🔄 手动刷新", command=self.scan_pads).pack(side="left")
        ttk.Button(bf1, text="💾 保存当前设备", command=self._save_devices).pack(side="left", padx=8)
        ttk.Label(bf1, text="(保存后断开重连将自动识别)", foreground="gray").pack(side="left")
        
        for label, ac, al, fn in [("🕹 游玩:", "cmb_play", "lbl_play", "_bind_play"),
                                   ("🎮 录制:", "cmb_rec", "lbl_rec_dev", "_bind_rec")]:
            r = ttk.Frame(f1)
            r.pack(fill="x", padx=4, pady=2)
            ttk.Label(r, text=label, width=8).pack(side="left")
            cmb = ttk.Combobox(r, state="readonly", width=48)
            cmb.pack(side="left", padx=4, fill="x", expand=True)
            cmb.bind("<<ComboboxSelected>>", lambda _, f2=fn: getattr(self, f2)())
            setattr(self, ac, cmb)
            lbl = ttk.Label(r, text="未选择", foreground="gray")
            lbl.pack(side="left", padx=4)
            setattr(self, al, lbl)

        # 取消 LabelFrame 边框节约空间
        f2 = ttk.Frame(self.top_pane)
        f2.pack(fill="x", padx=6, pady=2)
        r = ttk.Frame(f2)
        r.pack(fill="x", padx=4, pady=3)
        
        # 字体加大对齐
        ttk.Label(r, text="② 摇杆触发键").pack(side="left", padx=(0, 10))
        ttk.Label(r, text="按钮:").pack(side="left")
        self.var_tb = tk.StringVar(value=str(self.trigger_btn))
        ttk.Spinbox(r, from_=-1, to=20, width=4, textvariable=self.var_tb).pack(side="left", padx=2)
        ttk.Button(r, text="应用", command=self._apply_tb).pack(side="left", padx=2)
        ttk.Button(r, text="测试绑定", command=self._start_bind).pack(side="left", padx=2)
        self.lbl_tb = ttk.Label(r, text="(-1=禁用)", foreground="gray")
        self.lbl_tb.pack(side="left", padx=4)
        ttk.Separator(r, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Label(r, text="触发宏:").pack(side="left")
        self.var_trigger_macro = tk.StringVar(value="(未绑定)")
        self.cmb_trigger_macro = ttk.Combobox(r, textvariable=self.var_trigger_macro, state="readonly", width=22)
        self.cmb_trigger_macro.pack(side="left", padx=4)
        self.cmb_trigger_macro.bind("<<ComboboxSelected>>", self._on_trigger_macro_sel)

        f3 = ttk.LabelFrame(self.top_pane, text="③ 键盘/手柄热键 → 宏绑定")
        f3.pack(fill="x", padx=6, pady=2)
        self.hotkey_wgt = {}
        self.hotkey_combos = {}
        for slot in HOTKEY_SLOTS:
            r = ttk.Frame(f3)
            r.pack(fill="x", padx=4, pady=2)
            ttk.Label(r, text=f"  {slot['label']}:", width=8, anchor="w").pack(side="left")
            ki = self.hotkey_keys.get(slot["id"], {"type": "keyboard", "name": slot["default_name"], "scan_code": slot["default_scan"]})
            if ki.get("type") == "joystick":
                kdisp = f"{ki['name']} (joy)"
            else:
                kdisp = f"{ki.get('name')}  (scan:{ki.get('scan_code', '?')})"
            lk = ttk.Label(r, text=kdisp, foreground="green", width=20, anchor="w", font=("Consolas", 9))
            lk.pack(side="left", padx=(0, 2))
            bd = ttk.Button(r, text="设置按键", width=8, command=lambda sid=slot["id"]: self._start_detect_key(sid))
            bd.pack(side="left", padx=(0, 6))
            ttk.Label(r, text="→ 宏:").pack(side="left")
            var = tk.StringVar(value="(未绑定)")
            cb = ttk.Combobox(r, textvariable=var, state="readonly", width=22)
            cb.pack(side="left", padx=4)
            cb.bind("<<ComboboxSelected>>", lambda _, sid=slot["id"], v=var: self._on_hotkey_bind(sid, v))
            self.hotkey_wgt[slot["id"]] = {"lbl_key": lk, "btn_det": bd, "combo": cb, "var": var}
            self.hotkey_combos[slot["id"]] = {"combo": cb, "var": var}

        rm = ttk.Frame(f3)
        rm.pack(fill="x", padx=4, pady=(4, 4))
        ttk.Label(rm, text="  镜像键:", width=8, anchor="w").pack(side="left")
        mk = self.mirror_key
        if mk.get("type") == "joystick":
            mkdisp = f"{mk.get('name')} (joy)"
        else:
            mkdisp = f"{mk.get('name')}  (scan:{mk.get('scan_code', '?')})"
        self.lbl_mirror_key = ttk.Label(rm, text=mkdisp, foreground="green", width=20, anchor="w", font=("Consolas", 9))
        self.lbl_mirror_key.pack(side="left", padx=(0, 2))
        self.btn_mirror_det = ttk.Button(rm, text="设置按键", width=8, command=lambda: self._start_detect_key("mirror"))
        self.btn_mirror_det.pack(side="left", padx=(0, 6))
        self.lbl_mirror = ttk.Label(rm, text="镜像: 关闭", foreground="gray", font=("Microsoft YaHei UI", 10, "bold"))
        self.lbl_mirror.pack(side="left", padx=4)
        self.var_sound = tk.BooleanVar(value=self.sound_enabled)
        ttk.Checkbutton(rm, text="🔊 提示音", variable=self.var_sound, command=self._on_sound_toggle).pack(side="left", padx=(15, 0))

        f_prof = ttk.LabelFrame(self.top_pane, text="★ 人物配置 (一键保存/切换当前的所有按键设置)")
        f_prof.pack(fill="x", padx=6, pady=2)
        self.prof_container = ttk.Frame(f_prof)
        self.prof_container.pack(fill="x", padx=4, pady=3)
        self._build_profiles_ui()

        # 取消 LabelFrame 边框节约空间，将按钮与标题放回同一行
        f4 = ttk.Frame(self.top_pane)
        f4.pack(fill="x", padx=6, pady=2)
        r = ttk.Frame(f4)
        r.pack(fill="x", padx=4, pady=3)
        
        # 字体加大对齐
        ttk.Label(r, text="④ 手柄录制").pack(side="left", padx=(0, 4))
        
        self.btn_calib = ttk.Button(r, text="🎮 键位校准", command=self._start_calibration)
        self.btn_calib.pack(side="left", padx=(0, 10))

        self.btn_r1 = ttk.Button(r, text="▶ 开始(F1)", command=self.rec_start)
        self.btn_r1.pack(side="left", padx=2)
        self.btn_r2 = ttk.Button(r, text="⏹ 停止(F2)", command=self.rec_stop, state="disabled")
        self.btn_r2.pack(side="left", padx=2)
        self.lbl_rec = ttk.Label(r, text="就绪", foreground="gray")
        self.lbl_rec.pack(side="left", padx=8)
        ttk.Label(r, text="(F1开始 F2停止)", foreground="gray").pack(side="left")

        # 将宏列表放入 bottom_pane，鼠标放在边框上方即可拖拽拉高或拉低
        f5 = ttk.LabelFrame(self.bottom_pane, text="⑤ 宏列表 (双击=编辑，可按住此处上方边缘拖拽高度)")
        f5.pack(fill="both", expand=True, padx=6, pady=2)
        # 增加 exportselection=False 防止焦点丢失
        self.mlb = tk.Listbox(f5, height=5, font=("Consolas", 10), selectmode=tk.EXTENDED, exportselection=False)
        self.mlb.pack(fill="both", expand=True, padx=4, pady=(4, 0))
        self.mlb.bind("<Double-1>", self._on_dbl)
        bb = ttk.Frame(f5)
        bb.pack(fill="x", padx=4, pady=3)
        ttk.Button(bb, text="  读取宏", command=self._manual_load_macros).pack(side="left", padx=2)
        ttk.Button(bb, text="  复制", command=self._copy).pack(side="left", padx=2)
        ttk.Button(bb, text="✏ 重命名", command=self._ren).pack(side="left", padx=2)
        ttk.Button(bb, text="🗑 删除", command=self._mdel).pack(side="left", padx=2)
        ttk.Button(bb, text="♻ 回收站", command=self._show_recycle).pack(side="left", padx=2)
        ttk.Button(bb, text="➕ 新建", command=self._new).pack(side="left", padx=2)

    def _build_editor(self, p):
        top = ttk.Frame(p)
        top.pack(fill="x", padx=6, pady=4)
        ttk.Label(top, text="宏名:").pack(side="left")
        self.var_mname = tk.StringVar()
        ttk.Entry(top, textvariable=self.var_mname, width=24, font=("Microsoft YaHei UI", 11, "bold")).pack(side="left", padx=4)
        self.var_mname.trace_add("write", lambda *a: self._on_name_ed())
        self.lbl_es = ttk.Label(top, text="", foreground="green")
        self.lbl_es.pack(side="right", padx=8)

        self.ed_nb = ttk.Notebook(p)
        self.ed_nb.pack(fill="both", expand=True, padx=6, pady=(0, 4))

        pn = ttk.Frame(self.ed_nb)
        self.ed_nb.add(pn, text="  普通  ")
        self._build_normal_editor(pn)

        ps = ttk.Frame(self.ed_nb)
        self.ed_nb.add(ps, text="  源码(JSON)  ")
        self._build_source_editor(ps)
        self.ed_nb.bind("<<NotebookTabChanged>>", self._on_ed_tab_change)

    def _build_normal_editor(self, p):
        body = ttk.Frame(p)
        body.pack(fill="both", expand=True, padx=4, pady=4)

        left = ttk.Frame(body)
        left.pack(side="left", fill="both", expand=True)

        lf = ttk.Frame(left)
        lf.pack(fill="both", expand=True)
        # 增加 exportselection=False 解决点击按钮时选中状态丢失的问题
        self.ed_lb = tk.Listbox(lf, font=("Consolas", 10), selectmode=tk.EXTENDED, activestyle="dotbox", exportselection=False)
        sb = ttk.Scrollbar(lf, orient="vertical", command=self.ed_lb.yview)
        self.ed_lb.configure(yscrollcommand=sb.set)
        self.ed_lb.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.ed_lb.bind("<Double-1>", self._ed_dblclick)

        right = ttk.Frame(body, width=120)
        right.pack(side="right", fill="y", padx=(6, 0))
        right.pack_propagate(False)

        ttk.Label(right, text="移动", font=("", 9, "bold")).pack(pady=(0, 2))
        ttk.Button(right, text="▲ 上移", command=self._ed_move_up, width=10).pack(pady=1)
        ttk.Button(right, text="▼ 下移", command=self._ed_move_down, width=10).pack(pady=1)

        ttk.Separator(right, orient="horizontal").pack(fill="x", pady=6)
        ttk.Label(right, text="操作", font=("", 9, "bold")).pack(pady=(0, 2))
        ttk.Button(right, text="✏ 编辑", command=self._ed_edit, width=10).pack(pady=1)
        ttk.Button(right, text="📋 复制", command=self._ed_dup, width=10).pack(pady=1)
        ttk.Button(right, text="✕ 删除", command=self._ed_del, width=10).pack(pady=1)

        ttk.Separator(right, orient="horizontal").pack(fill="x", pady=6)
        ttk.Label(right, text="插入", font=("", 9, "bold")).pack(pady=(0, 2))
        for txt, tp, kw in[
            ("+ 延迟", "wait", {"delay": 16}),
            ("+ 按下", "press", {"btn": "A"}),
            ("+ 松开", "release", {"btn": "A"}),
            ("+ 方向", "dir", {"dir": "○中立"}),
            ("+ 连按", "tap", {"btn": "A", "rep": 1, "dur": 50, "gap": 30}),
            ("+ 注释", "comment", {"text": ""})]:
            ttk.Button(right, text=txt, width=10, command=lambda t=tp, k=kw: self._ed_insert(t, k)).pack(pady=1)

        self.tpl_frame = ttk.LabelFrame(p, text="快捷模板 (选定列表项后可存为模板，点击对应模板插入到当前选中之后)")
        self.tpl_frame.pack(fill="x", padx=4, pady=(0, 4))
        self._refresh_tpl_btns()

    def _refresh_tpl_btns(self):
        for w in self.tpl_frame.winfo_children(): w.destroy()
        r = ttk.Frame(self.tpl_frame)
        r.pack(fill="x", padx=4, pady=3)
        ttk.Button(r, text="➕存选中为模板", command=self._save_sel_as_tpl).pack(side="left", padx=(0, 10))
        for i, (label, tpl) in enumerate(self.custom_templates):
            bf = ttk.Frame(r)
            bf.pack(side="left", padx=2)
            ttk.Button(bf, text=label, command=lambda t=tpl: self._ed_insert_steps(t)).pack(side="left")
            ttk.Button(bf, text="✕", width=2, command=lambda idx=i: self._del_tpl(idx)).pack(side="left")

    def _save_sel_as_tpl(self):
        sel = self.ed_lb.curselection()
        if not sel:
            messagebox.showinfo("提示", "请先在列表区域(按住Ctrl或拖拽)选中要存为模板的步骤行", parent=self.root)
            return
        steps = self._ed_get_steps()
        tpl_steps = [copy.deepcopy(steps[i]) for i in sel]
        name = simpledialog.askstring("保存模板", "输入模板名称:", parent=self.root)
        if name and name.strip():
            self.custom_templates.append([name.strip(), tpl_steps])
            self._save_c()
            self._refresh_tpl_btns()

    def _del_tpl(self, idx):
        if messagebox.askyesno("删除", f"确认删除模板 '{self.custom_templates[idx][0]}' 吗？", parent=self.root):
            self.custom_templates.pop(idx)
            self._save_c()
            self._refresh_tpl_btns()

    def _build_source_editor(self, p):
        ttk.Label(p, text="直接编辑 JSON，修改后自动保存生效", foreground="#666").pack(padx=6, pady=(4, 0), anchor="w")
        self.src_text = tk.Text(p, font=("Consolas", 10), wrap="none", undo=True)
        sb = ttk.Scrollbar(p, orient="vertical", command=self.src_text.yview)
        self.src_text.configure(yscrollcommand=sb.set)
        self.src_text.pack(side="left", fill="both", expand=True, padx=(6, 0), pady=4)
        sb.pack(side="right", fill="y", padx=(0, 6), pady=4)
        
        self.src_text.bind("<<Modified>>", self._on_src_modified)

        bf = ttk.Frame(p)
        bf.pack(side="bottom", fill="x", padx=6, pady=(0, 4))
        ttk.Button(bf, text="💾 手动保存", command=self._src_save).pack(side="left", padx=4)
        ttk.Button(bf, text="🔄 重新载入", command=self._src_reload).pack(side="left", padx=4)
        self.lbl_src_st = ttk.Label(bf, text="", foreground="green")
        self.lbl_src_st.pack(side="left", padx=8)

    def _on_ed_tab_change(self, _=None):
        idx = self.ed_nb.index(self.ed_nb.select())
        if idx == 1: self._src_reload()

    # -- 普通视图操作 --
    def _ed_get_steps(self):
        if self.editing_idx < 0 or self.editing_idx >= len(self.macros): return []
        return self.macros[self.editing_idx].get("steps",[])

    def _ed_set_steps(self, steps):
        if self.editing_idx < 0 or self.editing_idx >= len(self.macros): return
        self.macros[self.editing_idx]["steps"] = steps
        self.macros[self.editing_idx]["events"] = steps_to_events(steps)
        self._save_profiles()

    def _ed_refresh_lb(self, sel_idx=None):
        steps = self._ed_get_steps()
        self.ed_lb.delete(0, "end")
        for i, s in enumerate(steps):
            self.ed_lb.insert("end", step_display(s, i))
        if sel_idx is not None and 0 <= sel_idx < len(steps):
            self.ed_lb.selection_clear(0, "end")
            self.ed_lb.selection_set(sel_idx)
            self.ed_lb.see(sel_idx)
            self.ed_lb.activate(sel_idx)
        self._ref_list()
        self.lbl_es.config(text=f"✅ {time.strftime('%H:%M:%S')}")

    def _ed_sel(self):
        sel = self.ed_lb.curselection()
        return sel[0] if sel else -1

    def _ed_move_up(self):
        i = self._ed_sel()
        if i <= 0: return
        steps = self._ed_get_steps()
        steps[i - 1], steps[i] = steps[i], steps[i - 1]
        self._ed_set_steps(steps)
        self._ed_refresh_lb(i - 1)

    def _ed_move_down(self):
        i = self._ed_sel()
        steps = self._ed_get_steps()
        if i < 0 or i >= len(steps) - 1: return
        steps[i], steps[i + 1] = steps[i + 1], steps[i]
        self._ed_set_steps(steps)
        self._ed_refresh_lb(i + 1)

    def _ed_edit(self):
        i = self._ed_sel()
        steps = self._ed_get_steps()
        if i < 0 or i >= len(steps): return
        dlg = StepEditDialog(self.root, steps[i])
        self.root.wait_window(dlg)
        if dlg.result:
            steps[i] = dlg.result
            self._ed_set_steps(steps)
            self._ed_refresh_lb(i)

    def _ed_dblclick(self, _): self._ed_edit()

    def _ed_dup(self):
        i = self._ed_sel()
        steps = self._ed_get_steps()
        if i < 0 or i >= len(steps): return
        steps.insert(i + 1, copy.deepcopy(steps[i]))
        self._ed_set_steps(steps)
        self._ed_refresh_lb(i + 1)

    def _ed_del(self):
        i = self._ed_sel()
        steps = self._ed_get_steps()
        if i < 0 or i >= len(steps): return
        steps.pop(i)
        self._ed_set_steps(steps)
        ni = min(i, len(steps) - 1)
        self._ed_refresh_lb(ni if ni >= 0 else None)

    def _ed_insert(self, tp, kw):
        steps = self._ed_get_steps()
        i = self._ed_sel()
        
        if tp == "comment":
            if i >= 0:
                s = steps[i]
                if s.get("type") == "comment":
                    if "disabled_step" in s:
                        steps[i] = s["disabled_step"]
                    else:
                        steps.pop(i)
                        i -= 1
                else:
                    desc = step_display(s, 0).split(".", 1)[-1].strip()
                    steps[i] = {"type": "comment", "text": f"(被注释) {desc}", "disabled_step": copy.deepcopy(s)}
                
                self._ed_set_steps(steps)
                self._ed_refresh_lb(max(0, i) if len(steps) > 0 else None)
            else:
                pos = len(steps)
                s = new_step(tp, **kw)
                steps.insert(pos, s)
                self._ed_set_steps(steps)
                self._ed_refresh_lb(pos)
            return

        pos = (i + 1) if i >= 0 else len(steps)
        s = new_step(tp, **kw)
        steps.insert(pos, s)
        self._ed_set_steps(steps)
        self._ed_refresh_lb(pos)

    def _ed_insert_steps(self, new_steps):
        steps = self._ed_get_steps()
        i = self._ed_sel()
        pos = (i + 1) if i >= 0 else len(steps)
        added = 0
        for s in copy.deepcopy(new_steps):
            if isinstance(s, tuple) or isinstance(s, list):
                item = s
                if item[0] == "wait": s = {"type": "wait", "delay": item[1]}
                elif item[0] == "dir": s = {"type": "dir", "dir": item[1]}
                elif item[0] == "press": s = {"type": "press", "btn": item[1]}
                elif item[0] == "release": s = {"type": "release", "btn": item[1]}
                else: continue
            steps.insert(pos + added, s)
            added += 1
        self._ed_set_steps(steps)
        self._ed_refresh_lb(pos + added - 1 if added else pos)

    # -- 源码视图操作 --
    def _src_reload(self):
        self._disable_src_modified = True
        steps = self._ed_get_steps()
        self.src_text.delete("1.0", "end")
        self.src_text.insert("1.0", json.dumps(steps, indent=2, ensure_ascii=False))
        self.lbl_src_st.config(text="已载入", foreground="gray")
        self.src_text.edit_modified(False)
        self._disable_src_modified = False

    def _on_src_modified(self, event=None):
        if getattr(self, '_disable_src_modified', False): return
        if self.src_text.edit_modified():
            if hasattr(self, '_src_save_after_id'):
                self.root.after_cancel(self._src_save_after_id)
            self._src_save_after_id = self.root.after(800, lambda: self._src_save(quiet=True))
            self.src_text.edit_modified(False)

    def _src_save(self, quiet=False):
        txt = self.src_text.get("1.0", "end").strip()
        if not txt:
            self._ed_set_steps([])
            self._ed_refresh_lb()
            self.lbl_src_st.config(text="✅ 已保存(空)", foreground="green")
            return
        try:
            data = json.loads(txt)
            if not isinstance(data, list): raise ValueError("顶层必须是数组")
            self._ed_set_steps(data)
            self._ed_refresh_lb()
            self.lbl_src_st.config(text=f"✅ 已保存 {time.strftime('%H:%M:%S')}", foreground="green")
        except Exception as e:
            self.lbl_src_st.config(text=f"❌ JSON错误: {e}", foreground="red")
            if not quiet:
                messagebox.showerror("JSON 解析错误", str(e), parent=self.root)

    def _on_name_ed(self):
        if getattr(self, '_disable_name_trace', False): return
        if self.editing_idx < 0 or self.editing_idx >= len(self.macros): return
        n = self.var_mname.get().strip()
        if n:
            self.macros[self.editing_idx]["name"] = n
            self._save_profiles()
            self._ref_list()
            self._update_all_combos()

    def _open_ed(self, idx):
        if idx < 0 or idx >= len(self.macros): return
        self.editing_idx = idx
        m = self.macros[idx]
        self._disable_name_trace = True
        self.var_mname.set(m["name"])
        self._disable_name_trace = False
        if "steps" in m and m["steps"]: m["steps"] = normalize_steps(m["steps"])
        elif "events" in m and m["events"]: m["steps"] = events_to_steps(m["events"])
        else: m["steps"] =[]
        self._ed_refresh_lb()
        self.lbl_es.config(text="")
        self.tabs.select(1)
        self._src_reload()

    # ── 宏列表 ──
    def _ref_list(self):
        self.mlb.delete(0, "end")
        for i, m in enumerate(self.macros):
            n = len(m.get("events",[]))
            ns = len(m.get("steps",[]))
            self.mlb.insert("end", f"  {m['name']}  ({ns}步/{n}事件)")
        self._update_all_combos()

    def _build_profiles_ui(self):
        for w in self.prof_container.winfo_children(): w.destroy()
        ttk.Button(self.prof_container, text="➕ 添加人物", command=self._add_profile).pack(side="left", padx=2)
        for i, prof in enumerate(self.profiles):
            is_active = (i == self.active_profile_idx)
            # [修正]: 放弃对 sv_ttk 样式的绝对依赖，增加显式的文本符号标识
            display_name = f"★ {prof['name']} " if is_active else prof["name"]
            style = "Accent.TButton" if is_active else "TButton"
            
            btn = ttk.Button(self.prof_container, text=display_name, style=style,
                            command=lambda idx=i: self._apply_profile(idx))
            btn.pack(side="left", padx=2)
            btn.bind("<Button-3>", lambda e, idx=i: self._profile_context_menu(e, idx))

    def _add_profile(self):
        dlg = tk.Toplevel(self.root)
        dlg.title("添加角色")
        dlg.geometry("320x220")
        dlg.transient(self.root)
        dlg.grab_set()
        
        ttk.Label(dlg, text="请输入新角色名称:").pack(pady=(10, 2))
        var_name = tk.StringVar()
        ttk.Entry(dlg, textvariable=var_name, width=30).pack(pady=2)
        
        ttk.Label(dlg, text="初始化选项:").pack(pady=(10, 2))
        var_mode = tk.StringVar(value="empty")
        ttk.Radiobutton(dlg, text="创建空白角色 (全新开始)", variable=var_mode, value="empty").pack(anchor="w", padx=40, pady=2)
        ttk.Radiobutton(dlg, text="从当前角色复制全部宏和按键", variable=var_mode, value="copy").pack(anchor="w", padx=40, pady=2)
        
        def _on_ok():
            name = var_name.get().strip()
            if not name:
                messagebox.showwarning("提示", "名称不能为空", parent=dlg)
                return
            mode = var_mode.get()
            
            if mode == "copy":
                prof = {
                    "name": name,
                    "trigger_btn": getattr(self, "trigger_btn", -1),
                    "trigger_macro_idx": getattr(self, "trigger_macro_idx", -1),
                    "hotkey_binds": copy.deepcopy(getattr(self, "hotkey_binds", {s["id"]: -1 for s in HOTKEY_SLOTS})),
                    "macros": copy.deepcopy(getattr(self, "macros", []))
                }
            else:
                prof = {
                    "name": name,
                    "trigger_btn": -1,
                    "trigger_macro_idx": -1,
                    "hotkey_binds": {s["id"]: -1 for s in HOTKEY_SLOTS},
                    "macros": []
                }
            
            self.profiles.append(prof)
            self._apply_profile(len(self.profiles) - 1)
            self._save_profiles()
            self._save_c()
            self._st(f"✅ 已新建并切换到人物: {name}")
            dlg.destroy()
            
        bf = ttk.Frame(dlg)
        bf.pack(pady=15)
        ttk.Button(bf, text="确定", command=_on_ok, width=10).pack(side="left", padx=10)
        ttk.Button(bf, text="取消", command=dlg.destroy, width=10).pack(side="left", padx=10)
        
        dlg.update_idletasks()
        pw = self.root.winfo_rootx() + self.root.winfo_width() // 2
        ph = self.root.winfo_rooty() + self.root.winfo_height() // 2
        w, h = dlg.winfo_width(), dlg.winfo_height()
        dlg.geometry(f"+{pw - w // 2}+{ph - h // 2}")
        self.root.wait_window(dlg)

    def _apply_profile(self, idx):
        if idx < 0 or idx >= len(self.profiles): return
        prof = self.profiles[idx]
        self.trigger_btn = prof.get("trigger_btn", -1)
        self.trigger_macro_idx = prof.get("trigger_macro_idx", -1)
        self.hotkey_binds = copy.deepcopy(prof.get("hotkey_binds", {s["id"]: -1 for s in HOTKEY_SLOTS}))
        
        if "macros" in prof:
            self.macros = copy.deepcopy(prof["macros"])
            
        self.active_profile_idx = idx
        
        self.editing_idx = -1
        if hasattr(self, 'var_mname'): self.var_mname.set("")
        if hasattr(self, 'ed_lb'): self.ed_lb.delete(0, "end")
        if hasattr(self, 'src_text'):
            self._disable_src_modified = True
            self.src_text.delete("1.0", "end")
            self.src_text.edit_modified(False)
            self._disable_src_modified = False
            self.lbl_src_st.config(text="")
            self.lbl_es.config(text="")
        
        if hasattr(self, 'var_tb'):
            self.var_tb.set(str(self.trigger_btn))
            self.lbl_tb.config(text=f"✅BTN{self.trigger_btn}" if self.trigger_btn >= 0 else "禁用", foreground="green" if self.trigger_btn >= 0 else "gray")
            self._ref_list()
            self._save_c()
            self._build_profiles_ui()
            self._st(f"✅ 已切换到人物: {prof['name']}")

    def _profile_context_menu(self, event, idx):
        menu = tk.Menu(self.root, tearoff=0)
        menu.add_command(label="✏ 重命名", command=lambda: self._rename_profile(idx))
        menu.add_command(label="✕ 删除", command=lambda: self._delete_profile(idx))
        menu.post(event.x_root, event.y_root)

    def _rename_profile(self, idx):
        old = self.profiles[idx]["name"]
        new = simpledialog.askstring("重命名", f"当前:{old}", initialvalue=old, parent=self.root)
        if new and new.strip():
            self.profiles[idx]["name"] = new.strip()
            self._save_c()
            self._build_profiles_ui()

    def _delete_profile(self, idx):
        if messagebox.askyesno("删除", f"确定要删除人物【{self.profiles[idx]['name']}】吗？", parent=self.root):
            self.profiles.pop(idx)
            if self.profiles:
                if self.active_profile_idx == idx:
                    self.active_profile_idx = -1
                    self._apply_profile(0)
                    # [优化]: 移除此处的冗余 _build_profiles_ui() 调用，因 _apply_profile 内已重绘
                elif self.active_profile_idx > idx:
                    self.active_profile_idx -= 1
                    self._build_profiles_ui() # 仅发生位移时单次重绘
            else:
                self.active_profile_idx = -1
                self.macros = []
                self.trigger_btn = -1
                self.trigger_macro_idx = -1
                self.hotkey_binds = {s["id"]: -1 for s in HOTKEY_SLOTS}
                
                self.editing_idx = -1
                if hasattr(self, 'var_mname'): self.var_mname.set("")
                if hasattr(self, 'ed_lb'): self.ed_lb.delete(0, "end")
                if hasattr(self, 'src_text'):
                    self._disable_src_modified = True
                    self.src_text.delete("1.0", "end")
                    self.src_text.edit_modified(False)
                    self._disable_src_modified = False
                    self.lbl_src_st.config(text="")
                    self.lbl_es.config(text="")
                if hasattr(self, 'var_tb'):
                    self.var_tb.set(str(self.trigger_btn))
                    self.lbl_tb.config(text="禁用", foreground="gray")
                    self._ref_list()
                
                self._build_profiles_ui()

            self._save_c()

    def _update_all_combos(self):
        names = ["(未绑定)"] +[m["name"] for m in self.macros]
        for sid, hw in self.hotkey_wgt.items():
            hw["combo"]["values"] = names
            idx = self.hotkey_binds.get(sid, -1)
            if 0 <= idx < len(self.macros): hw["var"].set(self.macros[idx]["name"])
            else: hw["var"].set("(未绑定)")
        self.cmb_trigger_macro["values"] = names
        if 0 <= self.trigger_macro_idx < len(self.macros):
            self.var_trigger_macro.set(self.macros[self.trigger_macro_idx]["name"])
        else:
            self.var_trigger_macro.set("(未绑定)")

    def _on_trigger_macro_sel(self, _=None):
        val = self.var_trigger_macro.get()
        if val == "(未绑定)": self.trigger_macro_idx = -1
        else:
            for i, m in enumerate(self.macros):
                if m["name"] == val:
                    self.trigger_macro_idx = i
                    break
        self._save_c()
        self._st(f"摇杆触发 → {val}")

    def _on_hotkey_bind(self, slot_id, var):
        val = var.get()
        if val == "(未绑定)": self.hotkey_binds[slot_id] = -1
        else:
            for i, m in enumerate(self.macros):
                if m["name"] == val:
                    self.hotkey_binds[slot_id] = i
                    break
        self._save_c()
        self._st(f"热键 {slot_id} → {val}")

    def _on_dbl(self, _=None):
        sel = self.mlb.curselection()
        if sel:
            idx = sel[0]
            self.root.after(0, lambda: self._open_ed(idx))

    def _copy(self):
        sel = self.mlb.curselection()
        if not sel: return
        for i in sel:
            m = copy.deepcopy(self.macros[i])
            m["name"] += "_副本"
            self.macros.append(m)
        self._save_profiles()
        self._ref_list()

    def _ren(self):
        sel = self.mlb.curselection()
        if not sel: return
        old = self.macros[sel[0]]["name"]
        new = simpledialog.askstring("重命名", f"当前:{old}", initialvalue=old)
        if new and new.strip():
            self.macros[sel[0]]["name"] = new.strip()
            self._save_profiles()
            self._ref_list()
            if self.editing_idx == sel[0]: self.var_mname.set(new.strip())

    def _mdel(self):
        sel = list(self.mlb.curselection())
        if not sel: return
        if not messagebox.askyesno("确认", f"删除 {len(sel)} 个宏？\n（可在回收站恢复）"): return
        deleted =[]
        for i in sorted(sel, reverse=True):
            deleted.append(copy.deepcopy(self.macros[i]))
            self.macros.pop(i)
        self.recycle_bin.extend(reversed(deleted))
        if self.editing_idx in sel:
            self.editing_idx = -1
            self.ed_lb.delete(0, "end")
            self.var_mname.set("")
        elif self.editing_idx >= 0:
            self.editing_idx -= sum(1 for i in sel if i < self.editing_idx)
        for sid in self.hotkey_binds:
            bi = self.hotkey_binds[sid]
            if bi in sel: self.hotkey_binds[sid] = -1
            elif bi >= 0: self.hotkey_binds[sid] -= sum(1 for i in sel if i < bi)
        if self.trigger_macro_idx in sel: self.trigger_macro_idx = -1
        elif self.trigger_macro_idx >= 0: self.trigger_macro_idx -= sum(1 for i in sel if i < self.trigger_macro_idx)
        
        self._save_profiles()
        self._save_c()
        self._ref_list()
        self._st(f"已删除 {len(sel)} 个宏 → 回收站({len(self.recycle_bin)})")

    def _new(self):
        if self.active_profile_idx < 0 or not self.profiles:
            messagebox.showwarning("提示", "当前没有选择任何人物配置，请先新建人物！", parent=self.root)
            self._add_profile()
            return
        name = f"macro_{len(self.macros) + 1}"
        self.macros.append({"name": name, "events":[], "steps":[]})
        self._save_profiles()
        self._ref_list()
        self._open_ed(len(self.macros) - 1)

    def _show_recycle(self):
        if not self.recycle_bin:
            messagebox.showinfo("回收站", "回收站为空\n(关闭软件后自动清空)", parent=self.root)
            return
        win = tk.Toplevel(self.root)
        win.title(f"♻ 回收站 ({len(self.recycle_bin)} 项)")
        win.geometry("420x350")
        win.transient(self.root)
        win.grab_set()

        ttk.Label(win, text="选中后点「恢复」（关闭软件后自动清空）", foreground="#666").pack(padx=8, pady=(6, 2), anchor="w")

        # 增加 exportselection=False
        lb = tk.Listbox(win, font=("Consolas", 10), selectmode=tk.EXTENDED, exportselection=False)
        lb.pack(fill="both", expand=True, padx=8, pady=4)
        for m in self.recycle_bin:
            ns = len(m.get("steps",[]))
            lb.insert("end", f"{m['name']}  ({ns}步)")

        def restore():
            sel = list(lb.curselection())
            if not sel: return
            for i in sorted(sel, reverse=True):
                self.macros.append(self.recycle_bin.pop(i))
            self._save_profiles()
            self._ref_list()
            lb.delete(0, "end")
            for m in self.recycle_bin:
                ns = len(m.get("steps",[]))
                lb.insert("end", f"{m['name']}  ({ns}步)")
            win.title(f"♻ 回收站 ({len(self.recycle_bin)} 项)")
            self._st(f"已恢复 {len(sel)} 个宏")

        def clear_all():
            if messagebox.askyesno("确认", "清空回收站？不可恢复！", parent=win):
                self.recycle_bin.clear()
                lb.delete(0, "end")
                win.title("♻ 回收站 (0 项)")

        bf = ttk.Frame(win)
        bf.pack(fill="x", padx=8, pady=(0, 8))
        ttk.Button(bf, text="♻ 恢复选中", command=restore).pack(side="left", padx=4)
        ttk.Button(bf, text="🗑 清空全部", command=clear_all).pack(side="left", padx=4)
        ttk.Button(bf, text="关闭", command=win.destroy).pack(side="right", padx=4)

    # ── 设备 ──
    def _save_devices(self):
        if self.play_joy:
            self.saved_play_guid = self.play_guid
            self.saved_play_name = self.play_joy.get_name()
        if self.rec_joy:
            self.saved_rec_guid = self.rec_guid
            self.saved_rec_name = self.rec_joy.get_name()
        self._save_c()
        self._st("✅ 已保存设备！即使拔掉手柄，程序也会记住它们。")
        self.scan_pads()

    def scan_pads(self):
        # [B2修复] 录制/回放进行中禁止重建摇杆子系统，避免销毁正在使用的手柄
        if getattr(self, "recording", False) or getattr(self, "playing", False):
            return
        for j in[self.play_joy, self.rec_joy]:
            if j:
                try: j.quit()
                except Exception: pass
        self.play_joy = self.rec_joy = None
        try: pygame.joystick.quit()
        except Exception: pass
        try: pygame.joystick.init()
        except Exception: pass
        safe_pump()
        time.sleep(0.05)
        safe_pump()
        self.pad_list =[]
        for i in range(pygame.joystick.get_count()):
            try:
                j = pygame.joystick.Joystick(i)
                self.pad_list.append((f"[{i}] {j.get_name()} (B:{j.get_numbuttons()} A:{j.get_numaxes()} H:{j.get_numhats()})", j.get_guid(), i))
                j.quit()
            except Exception: pass
        play_names = [p[0] for p in self.pad_list]
        rec_names = [p[0] for p in self.pad_list]
        
        self.pad_list_play = list(self.pad_list)
        self.pad_list_rec = list(self.pad_list)

        sgp = getattr(self, "saved_play_guid", None)
        if sgp and not any(p[1] == sgp for p in self.pad_list):
            play_names.append(f"[离线记忆] {getattr(self, 'saved_play_name', '未知设备')}")
            self.pad_list_play.append((play_names[-1], sgp, -1))

        sgr = getattr(self, "saved_rec_guid", None)
        if sgr and not any(p[1] == sgr for p in self.pad_list):
            rec_names.append(f"[离线记忆] {getattr(self, 'saved_rec_name', '未知设备')}")
            self.pad_list_rec.append((rec_names[-1], sgr, -1))

        self.cmb_play["values"] = play_names
        self.cmb_rec["values"] = rec_names

        for idx, p in enumerate(self.pad_list_play):
            if p[1] == sgp or (self.play_guid and p[1] == self.play_guid):
                self.cmb_play.current(idx)
                self._bind_play()
                break

        for idx, p in enumerate(self.pad_list_rec):
            if p[1] == sgr or (self.rec_guid and p[1] == self.rec_guid):
                self.cmb_rec.current(idx)
                self._bind_rec()
                break

        if not self.pad_list and not sgp and not sgr:
            self.lbl_play.config(text="无设备", foreground="red")
            self.lbl_rec_dev.config(text="无设备", foreground="red")

    def _bind_play(self):
        idx = self.cmb_play.current()
        if idx < 0: return
        if self.play_joy:
            try: self.play_joy.quit()
            except Exception: pass
        _, guid, pidx = self.pad_list_play[idx]
        self.play_guid = guid
        if pidx == -1:
            self.play_joy = None
            self.lbl_play.config(text="⚠离线(插上后将自动连)", foreground="orange")
            return
        try:
            self.play_joy = pygame.joystick.Joystick(pidx)
            self.play_joy.init()
            self.play_nb = self.play_joy.get_numbuttons()
        except Exception as e:
            self.lbl_play.config(text=f"❌{e}", foreground="red")
            return
        safe_pump()
        self.play_prev_b = {i: self.play_joy.get_button(i) for i in range(self.play_nb)}
        self.play_prev_h_play = {i: self.play_joy.get_hat(i) for i in range(self.play_joy.get_numhats())}
        self.lbl_play.config(text=f"✅ {self.play_joy.get_name()}", foreground="green")
        self._save_c()

    def _bind_rec(self):
        idx = self.cmb_rec.current()
        if idx < 0: return
        if self.rec_joy:
            try: self.rec_joy.quit()
            except Exception: pass
        _, guid, pidx = self.pad_list_rec[idx]
        self.rec_guid = guid
        if pidx == -1:
            self.rec_joy = None
            self.lbl_rec_dev.config(text="⚠离线(插上后将自动连)", foreground="orange")
            return
        try:
            self.rec_joy = pygame.joystick.Joystick(pidx)
            self.rec_joy.init()
        except Exception as e:
            self.lbl_rec_dev.config(text=f"❌{e}", foreground="red")
            return
        self.rec_nb = self.rec_joy.get_numbuttons()
        self.rec_na = self.rec_joy.get_numaxes()
        self.rec_nh = self.rec_joy.get_numhats()
        safe_pump()
        self.rec_prev_b = {i: self.rec_joy.get_button(i) for i in range(self.rec_nb)}
        self.rec_prev_a = {i: round(self.rec_joy.get_axis(i), 4) for i in range(self.rec_na)}
        self.rec_prev_h = {i: self.rec_joy.get_hat(i) for i in range(self.rec_nh)}
        self.lbl_rec_dev.config(text=f"✅ {self.rec_joy.get_name()}", foreground="green")
        self._save_c()

    def rec_start(self):
        if not self.license_mgr.can_record():
            messagebox.showwarning("授权提示", self.license_mgr.get_deny_message(), parent=self.root)
            return
            
        if self.active_profile_idx < 0 or not self.profiles:
            messagebox.showwarning("提示", "当前没有选择任何人物配置，请先新建人物才能录制！", parent=self.root)
            self.root.after(0, self._add_profile)
            return
            
        if self.recording: return
        if not self.play_joy:
            self._st("⚠ 选游玩手柄")
            return
        # [B4修复] 免费计时移到真正开始录制之后，避免未选游玩手柄就按 F1 空耗额度
        self.license_mgr.free_timer_start()
        
        threading.Thread(target=lambda: winsound.Beep(1000, 200), daemon=True).start()
        
        num = 1
        existing = {m["name"] for m in self.macros}
        while f"录制{num}" in existing:
            num += 1
        name = f"录制{num}"
        self.macros.append({"name": name, "events": [], "steps": []})
        self.rec_macro_idx = len(self.macros) - 1
        self._ref_list()
        self.mlb.selection_clear(0, "end")
        self.mlb.selection_set(self.rec_macro_idx)
        self.mlb.see(self.rec_macro_idx)
        
        self.recording = True
        self.rec_buf = []
        self.rec_t0 = time.perf_counter()
        self.btn_r1.config(state="disabled")
        self.btn_r2.config(state="normal")
        self.lbl_rec.config(text=f"🔴 录制中 [{name}]...", foreground="red")
        self._st(f"🔴 开始录制 → {name}")

    def rec_stop(self):
        self.license_mgr.free_timer_stop()
        if not self.recording:
            self._st("⚠ 当前未在录制状态，请先按F1开始录制")
            return
        
        def _f2_beeps():
            winsound.Beep(1000, 150)
            time.sleep(0.05)
            winsound.Beep(1000, 150)
        threading.Thread(target=_f2_beeps, daemon=True).start()
        
        self.recording = False
        self.btn_r1.config(state="normal")
        self.btn_r2.config(state="disabled")
        self.lbl_rec.config(text="就绪", foreground="gray")
        
        idx = getattr(self, "rec_macro_idx", -1)
        if idx < 0 or idx >= len(self.macros):
            self._st("⚠ 录制异常：找不到目标宏")
            return
        
        name = self.macros[idx]["name"]
        
        if not self.rec_buf:
            self.macros.pop(idx)
            self._ref_list()
            self._st(f"⚠ 录制为空，已移除 '{name}'")
            self.rec_macro_idx = -1
            return
        
        steps = events_to_steps(self.rec_buf)
        self.macros[idx]["events"] = copy.deepcopy(self.rec_buf)
        self.macros[idx]["steps"] = steps
        
        if 0 <= self.active_profile_idx < len(self.profiles):
            self.profiles[self.active_profile_idx]["macros"] = copy.deepcopy(self.macros)
        self._save_profiles()
        self._ref_list()
        
        self.mlb.selection_clear(0, "end")
        self.mlb.selection_set(idx)
        self.mlb.see(idx)
        self._open_ed(idx)
        
        self.rec_macro_idx = -1
        self._st(f"✅ 已录制 '{name}' ({len(self.rec_buf)}事件/{len(steps)}步) → {self.profiles[self.active_profile_idx]['name']}")

    def _start_calibration(self):
        if not self.play_joy and not self.rec_joy:
            import tkinter.messagebox as messagebox
            messagebox.showwarning("提示", "请先在上方连接设备后再校准", parent=self.root)
            return
        
        self.calib_win = tk.Toplevel(self.root)
        self.calib_win.title("手柄/摇杆 键位映射设定")
        
        # 【修复】：删掉 geometry 写死的宽度高度，让弹窗自适应系统文字缩放比例，绝不会再遮挡
        self.calib_win.transient(self.root)
        self.calib_win.grab_set()

        # 【修复2的核心】拦截右上角的 X 关闭按钮，确保强制退出校准模式
        self.calib_win.protocol("WM_DELETE_WINDOW", self._cancel_calibration)

        ttk.Label(self.calib_win, text="点击对应按键右侧的 [绑定] 按钮，然后按下物理外设上的键位。\n(摇杆没有的键位无需绑定)", foreground="#555").pack(pady=(10, 5))

        self.standard_btns = [
            ("X (左拳 LP)", 2), ("Y (右拳 RP)", 3), ("LB (左肩键)", 4), ("RB (右肩键)", 5),
            ("A (左脚 LK)", 0), ("B (右脚 RK)", 1), ("Back (投币/返回)", 6), ("Start (开始)", 7)
        ]
        
        self.calib_frame = ttk.Frame(self.calib_win)
        self.calib_frame.pack(fill="both", expand=True, padx=20, pady=5)
        
        self.calib_labels = {}
        self.calib_waiting_for = None  
        self.calib_temp_map = copy.deepcopy(getattr(self, "btn_map", {}))
        inv_map = {v: k for k, v in self.calib_temp_map.items()}

        for i, (name, std_id) in enumerate(self.standard_btns):
            row = i // 2
            col = (i % 2) * 3
            ttk.Label(self.calib_frame, text=name, width=14, anchor="e").grid(row=row, column=col, pady=8, padx=2)
            
            current_phys = inv_map.get(std_id, std_id) 
            lbl_val = ttk.Label(self.calib_frame, text=f"Joy B{current_phys}", width=8, foreground="green")
            lbl_val.grid(row=row, column=col+1, pady=8, padx=2)
            self.calib_labels[std_id] = lbl_val
            
            btn = ttk.Button(self.calib_frame, text="绑定", width=6, 
                             command=lambda s_id=std_id: self._listen_for_bind(s_id))
            btn.grid(row=row, column=col+2, pady=8, padx=2)

        self.lbl_calib_msg = ttk.Label(self.calib_win, text="", font=("Microsoft YaHei UI", 10, "bold"), foreground="blue")
        self.lbl_calib_msg.pack(pady=5)

        bf = ttk.Frame(self.calib_win)
        bf.pack(pady=10)
        ttk.Button(bf, text="💾 保存并生效", command=self._save_calibration).pack(side="left", padx=10)
        ttk.Button(bf, text="清空重置", command=self._reset_calibration).pack(side="left", padx=10)
        
        # 【修复2】点击取消按钮时，调用完整的清理退出函数，不再引发后台死锁
        ttk.Button(bf, text="取消", command=self._cancel_calibration).pack(side="left", padx=10)

        # 开启后台拦截标记
        self.calibrating = True

        # === 动态计算坐标并移动窗口 ===
        # 强制刷新UI，让系统算出页面自适应后的真实宽度和高度
        self.calib_win.update_idletasks()
        
        # 获取主界面的坐标和宽高
        main_x = self.root.winfo_rootx()
        main_y = self.root.winfo_rooty()
        main_w = self.root.winfo_width()
        main_h = self.root.winfo_height()
        
        # 获取校准窗口的宽高
        cw = self.calib_win.winfo_width()
        ch = self.calib_win.winfo_height()
        
        # 计算坐标：Y轴在主程序正中间，X轴贴着主程序内部最右侧(预留10像素边距)
        target_x = main_x + main_w - cw - 10
        target_y = main_y + (main_h - ch) // 2
        
        # 应用新坐标
        self.calib_win.geometry(f"+{target_x}+{target_y}")

    def _cancel_calibration(self):
        """完美退出校准状态，释放手柄输入拦截，拯救热键"""
        self.calibrating = False
        if hasattr(self, 'calib_win') and self.calib_win.winfo_exists():
            self.calib_win.destroy()

    def _listen_for_bind(self, std_id):
        self.calib_waiting_for = std_id
        for s_id, lbl in self.calib_labels.items():
            if s_id == std_id:
                lbl.config(text="请按键...", foreground="red")
            else:
                inv_map = {v: k for k, v in self.calib_temp_map.items()}
                curr = inv_map.get(s_id, s_id)
                lbl.config(text=f"Joy B{curr}", foreground="green")
        
        name = next((n for n, sid in self.standard_btns if sid == std_id), "")
        self.lbl_calib_msg.config(text=f"正在绑定 [{name}]，请按下外设上的对应物理按键！")

    def _calib_advance(self, phys_btn_id):
        if not getattr(self, "calibrating", False) or self.calib_waiting_for is None:
            return
            
        std_id = self.calib_waiting_for
        keys_to_remove = [k for k, v in self.calib_temp_map.items() if v == std_id or k == phys_btn_id]
        for k in keys_to_remove:
            self.calib_temp_map.pop(k, None)
            
        self.calib_temp_map[phys_btn_id] = std_id
        self.calib_labels[std_id].config(text=f"Joy B{phys_btn_id}", foreground="green")
        self.lbl_calib_msg.config(text=f"✅ 绑定成功！物理键 B{phys_btn_id} -> 虚拟键 {std_id}")
        self.calib_waiting_for = None

    def _reset_calibration(self):
        self.calib_temp_map.clear()
        for s_id, lbl in self.calib_labels.items():
            lbl.config(text=f"Joy B{s_id}", foreground="gray")
        self.lbl_calib_msg.config(text="已清空所有映射，恢复默认直通状态")

    def _save_calibration(self):
        import copy
        import tkinter.messagebox as messagebox
        self.btn_map = copy.deepcopy(self.calib_temp_map)
        
        # 安全退出校准状态
        self.calibrating = False
        self._save_c()
        self.calib_win.destroy()
        
        # 弹窗提示需要重新绑定热键
        messagebox.showinfo("保存成功", "✅ 键位底层映射已永久锁死！\n\n【重要提示】：由于您的底层按键代码已经被修正，如果您之前绑定了触发热键，请在主界面点击【设置按键】重新绑定一下热键！", parent=self.root)

    def _rec_add(self, tp, eid, val):
        if not self.recording: return
        t_now = round((time.perf_counter() - self.rec_t0) * 1000, 1)
        
        # 【修复】毫秒级防抖与双份去重：20ms 内同 type/id/val 直接抛弃
        # （已知权衡 B16：极快速合法连打可能被吞掉一个，但避免了抖动误录，保持现状不改）
        if self.rec_buf:
            last = self.rec_buf[-1]
            if last["type"] == tp and last["id"] == eid and last["val"] == val:
                if (t_now - last["t"]) < 20:
                    return
                    
        self.rec_buf.append({"t": t_now, "type": tp, "id": eid, "val": val})

    def _trigger_macro(self):
        if not self._is_target_active(): return
        if 0 <= self.trigger_macro_idx < len(self.macros):
            self._play_macro(self.trigger_macro_idx)

    def _play_macro(self, idx):
        if not self.license_mgr.can_play_macro():
            self.root.after(0, lambda: messagebox.showwarning("授权提示", self.license_mgr.get_deny_message(), parent=self.root))
            return
        if self.playing or self.recording: return
        if idx < 0 or idx >= len(self.macros): return
        threading.Thread(target=self._play, args=(idx,), daemon=True).start()

    def _play(self, idx):
        self.license_mgr.free_timer_start()
        try:
            self.playing = True
            self._enable_win_hires_timer()
            m = self.macros[idx]
            if "steps" in m and m["steps"]:
                evts = steps_to_events(m["steps"], mirror=self.mirror)
            else:
                evts = m.get("events",[])
                if self.mirror:
                    evts = copy.deepcopy(evts)
                    for ev in evts:
                        if ev["type"] == "hat":
                            val = tuple(ev["val"])
                            ev["val"] = list(MIRROR_DIR.get(val, val))
            self.root.after(0, lambda: self._st(f"▶ {m['name']}{'  🔄镜像' if self.mirror else ''}"))
            self.vpad.reset()
            self.vpad.update()
            t0 = time.perf_counter()
            for ev in evts:
                if not self.alive: break
                tgt = ev["t"] / 1000.0
                dt = tgt - (time.perf_counter() - t0)
                # [B11修复] 启用高精度定时器后，预睡到目标前 sub-ms 再忙等余下时间，
                # 在保持铁拳宏时序精度的同时显著降低单核占用
                _margin = 0.0005 if getattr(self, "_hires_on", False) else 0.0015
                if dt > _margin: time.sleep(dt - _margin)
                while time.perf_counter() - t0 < tgt:
                    pass
                self._appl(ev)
            time.sleep(0.02)
            self.vpad.reset()
            self.vpad.update()
            self.playing = False
            self.root.after(0, lambda: self._st("✅ 完成"))
        finally:
            self._disable_win_hires_timer()
            self.license_mgr.free_timer_stop()

    def _appl(self, ev):
        if not self.vpad: return
        try:
            tp, i, v = ev["type"], ev["id"], ev["val"]
            if tp == "btn":
                if 0 <= i < len(XBOX_BTN):
                    if v: self.vpad.press_button(button=XBOX_BTN[i])
                    else: self.vpad.release_button(button=XBOX_BTN[i])
            elif tp == "hat":
                for d in DP.values(): self.vpad.release_button(button=d)
                hx, hy = v
                if hy > 0: self.vpad.press_button(button=DP["U"])
                if hy < 0: self.vpad.press_button(button=DP["D"])
                if hx < 0: self.vpad.press_button(button=DP["L"])
                if hx > 0: self.vpad.press_button(button=DP["R"])
            self.vpad.update()
        except Exception: pass

    def _enable_win_hires_timer(self):
        """[B11修复] 提升 Windows 系统定时器分辨率到 1ms，使回放时的 time.sleep 预睡更精确，
        从而减少忙等时间、降低单核占用。非 Windows 或调用失败时静默跳过。"""
        self._hires_on = False
        if os.name == "nt":
            try:
                ctypes.windll.winmm.timeBeginPeriod(1)
                self._hires_on = True
            except Exception:
                self._hires_on = False

    def _disable_win_hires_timer(self):
        if getattr(self, "_hires_on", False):
            try:
                ctypes.windll.winmm.timeEndPeriod(1)
            except Exception:
                pass
            self._hires_on = False

    def _poll_loop(self):
        while self.alive:
            try: self._do_poll()
            except Exception: pass
            time.sleep(POLL_MS / 1000.0)

    def _do_poll(self):
        try:
            for ev in pygame.event.get():
                if ev.type in (pygame.JOYDEVICEADDED, pygame.JOYDEVICEREMOVED):
                    self._st("🔌 设备变化")
        except Exception: safe_pump()
        logs =[]
        
        if self.play_joy:
            try:
                pb = {i: self.play_joy.get_button(i) for i in range(self.play_nb)}
                self.play_cur_b = pb
                
                # --- 新增: 将左摇杆、D-Pad按钮(11-14) 统合为标准方向 Hat(0) 解决无法录制方向问题 ---
                hx, hy = 0, 0
                if self.play_nb > 11:
                    hx = pb.get(14, 0) - pb.get(13, 0)
                    hy = pb.get(11, 0) - pb.get(12, 0)
                
                real_hx, real_hy = 0, 0
                play_nh = self.play_joy.get_numhats()
                if play_nh > 0:
                    real_hx, real_hy = self.play_joy.get_hat(0)
                
                ax_dir, ay_dir = 0, 0
                play_na = self.play_joy.get_numaxes()
                if play_na >= 2:
                    ax = self.play_joy.get_axis(0)
                    ay = self.play_joy.get_axis(1)
                    if abs(ax) > 0.5: ax_dir = 1 if ax > 0 else -1
                    if abs(ay) > 0.5: ay_dir = -1 if ay > 0 else 1
                
                final_hx = real_hx or hx or ax_dir
                final_hy = real_hy or hy or ay_dir
                final_h = (final_hx, final_hy)
                
                prev_h = self.play_prev_h_play.get(0, (0, 0))
                if final_h != prev_h:
                    if self.recording: self._rec_add("hat", 0, list(final_h))
                    self.play_prev_h_play[0] = final_h
                    logs.append(f"🕹H0:{final_h}")

                for i in range(1, play_nh):
                    cur_h = self.play_joy.get_hat(i)
                    prev_h2 = self.play_prev_h_play.get(i, (0, 0))
                    if cur_h != prev_h2:
                        if self.recording: self._rec_add("hat", i, list(cur_h))
                        self.play_prev_h_play[i] = cur_h

                for i in range(self.play_nb):
                    if 11 <= i <= 14: continue # 屏蔽已转换为 Hat 的 D-Pad 按钮
                    o, n = self.play_prev_b.get(i, 0), pb[i]
                    if n != o:
                        # 拦截处于校准状态时的按键
                        if n == 1 and getattr(self, "calibrating", False):
                            self.root.after(0, lambda b=i: self._calib_advance(b))
                            continue
                            
                        # 核心防错位：将设备乱七八糟的底层编号强制转换为校准后的标准 Xbox 编号
                        mapped_i = getattr(self, 'btn_map', {}).get(i, i)
                        
                        if self.recording: self._rec_add("btn", mapped_i, n)
                        if n == 1:
                            if self._detecting_slot is not None:
                                self._detect_kb_flag = False
                                slot_id = self._detecting_slot
                                self._detecting_slot = None
                                self.root.after(0, lambda sid=slot_id, btn=mapped_i: self._finish_detect(sid, "joystick", f"Joy B{btn}", btn))
                            elif self.binding:
                                self.binding = False
                                def _apply_bind(btn_idx=mapped_i):
                                    self.trigger_btn = btn_idx
                                    self.var_tb.set(str(btn_idx))
                                    self.lbl_tb.config(text=f"✅BTN{btn_idx}", foreground="green")
                                    self._save_c()
                                self.root.after(0, _apply_bind)
                            if mapped_i == self.trigger_btn:
                                self.root.after(0, self._trigger_macro)
                            # 修改后: 将字典转换为列表副本以保证线程安全 (Thread Safety)
                            hotkey_binds_copy = list(self.hotkey_binds.items())
                            for sid, m_idx in hotkey_binds_copy:
                                if m_idx >= 0:
                                    ki = self.hotkey_keys.get(sid, {})
                                    if ki.get("type") == "joystick" and ki.get("scan_code") == mapped_i:
                                        self.root.after(0, lambda s=sid: self._on_hotkey(s))
                            mk = self.mirror_key
                            if mk.get("type") == "joystick" and mk.get("scan_code") == mapped_i:
                                self.root.after(0, self._toggle_mirror)
                        logs.append(f"🕹B{mapped_i}{'↓' if n else '↑'}")
                self.play_prev_b = pb
            except Exception:
                self.play_joy = None
                self.root.after(0, lambda: self.lbl_play.config(text="⚠断开", foreground="red"))
        if self.rec_joy:
            try:
                nb, na, nh = self.rec_nb, self.rec_na, self.rec_nh
                new_b = {i: self.rec_joy.get_button(i) for i in range(nb)}
                new_a = {i: round(self.rec_joy.get_axis(i), 4) for i in range(na)}
                new_h = {i: self.rec_joy.get_hat(i) for i in range(nh)}
                self.rec_cur_b = new_b
                self.rec_cur_a = new_a
                self.rec_cur_h = new_h
                
                hx, hy = 0, 0
                if nb > 11:
                    hx = new_b.get(14, 0) - new_b.get(13, 0)
                    hy = new_b.get(11, 0) - new_b.get(12, 0)
                
                real_hx, real_hy = 0, 0
                if nh > 0:
                    real_hx, real_hy = new_h[0]
                    
                ax_dir, ay_dir = 0, 0
                if na >= 2:
                    ax = new_a.get(0, 0)
                    ay = new_a.get(1, 0)
                    if abs(ax) > 0.5: ax_dir = 1 if ax > 0 else -1
                    if abs(ay) > 0.5: ay_dir = -1 if ay > 0 else 1
                
                final_hx = real_hx or hx or ax_dir
                final_hy = real_hy or hy or ay_dir
                final_h = (final_hx, final_hy)
                
                prev_h = self.rec_prev_h.get(0, (0, 0))
                if final_h != prev_h:
                    if self.recording: self._rec_add("hat", 0, list(final_h))
                    self.rec_prev_h[0] = final_h
                    logs.append(f"🎮H0:{final_h}")

                for i in range(1, nh):
                    o, n = self.rec_prev_h.get(i, (0, 0)), new_h[i]
                    if n != o:
                        if self.recording: self._rec_add("hat", i, list(n))
                        logs.append(f"🎮H{i}:{n}")

                for i in range(nb):
                    # 修改后: 增加前提条件，仅当该手柄确实被判断为将 D-Pad 映射到 11-14 键时才屏蔽
                    is_dpad_btn = (nb > 11 and i in (11, 12, 13, 14) and 
                                   (new_b.get(11) or new_b.get(12) or 
                                    new_b.get(13) or new_b.get(14)))
                    if is_dpad_btn and getattr(self, "force_btn_dpad", True): continue
                    o, n = self.rec_prev_b.get(i, 0), new_b[i]
                    if n != o:
                        # 拦截校准
                        if n == 1 and getattr(self, "calibrating", False):
                            self.root.after(0, lambda b=i: self._calib_advance(b))
                            continue
                            
                        mapped_i = getattr(self, 'btn_map', {}).get(i, i)
                        if self.recording: self._rec_add("btn", mapped_i, n)
                        logs.append(f"🎮B{mapped_i}{'↓' if n else '↑'}")
                
                self.rec_prev_b = new_b
                self.rec_prev_a = new_a
                
                # [核心修复] 将上方合成的摇杆与十字键的真实最终方向，同步回字典
                if nh > 0:
                    new_h[0] = final_h
                self.rec_prev_h = new_h
            except Exception:
                self.rec_joy = None
                self.root.after(0, lambda: self.lbl_rec_dev.config(text="⚠断开", foreground="red"))
        if logs and self.monitor_on: self._log(" | ".join(logs))

    def _build_monitor(self, p):
        f = ttk.Frame(p)
        f.pack(fill="both", expand=True, padx=6, pady=4)
        r = ttk.Frame(f)
        r.pack(fill="x", pady=2)
        self.var_mon = tk.BooleanVar(value=self.monitor_on)
        ttk.Checkbutton(r, text="启用实时监控", variable=self.var_mon, command=self._on_mon_toggle).pack(side="left")
        ttk.Button(r, text="清空", command=self._clr).pack(side="right")
        self.lbl_live = tk.Label(f, text="(选设备)", font=("Consolas", 10), anchor="w", justify="left", bg="#1a1a2e", fg="#00ff88", padx=6, pady=6)
        self.lbl_live.pack(fill="x", pady=(4, 0))
        self.txt_log = tk.Text(f, height=15, font=("Consolas", 8), state="disabled", bg="#111", fg="#0f0")
        sb2 = ttk.Scrollbar(f, orient="vertical", command=self.txt_log.yview)
        self.txt_log.configure(yscrollcommand=sb2.set)
        self.txt_log.pack(side="left", fill="both", expand=True, pady=(4, 0))
        sb2.pack(side="right", fill="y", pady=(4, 0))

    def _on_mon_toggle(self):
        self.monitor_on = self.var_mon.get()
        self._save_c()

    def _log(self, t):
        def _update():
            if not getattr(self, 'alive', False): return
            try:
                self.txt_log.config(state="normal")
                self.txt_log.insert("end", f"[{time.strftime('%H:%M:%S')}] {t}\n")
                self.txt_log.see("end")
                n = int(self.txt_log.index("end-1c").split(".")[0])
                if n > 300: self.txt_log.delete("1.0", f"{n - 300}.0")
                self.txt_log.config(state="disabled")
            except Exception: pass
        try: self.root.after(0, _update)
        except Exception: pass

    def _clr(self):
        self.txt_log.config(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.config(state="disabled")

    def _apply_tb(self):
        try:
            v = int(self.var_tb.get())
            self.trigger_btn = v
            self.lbl_tb.config(text=f"✅BTN{v}" if v >= 0 else "禁用", foreground="green" if v >= 0 else "gray")
            self._save_c()
        except Exception: self.lbl_tb.config(text="❌", foreground="red")

    def _start_bind(self):
        if not self.play_joy:
            self._st("⚠ 选摇杆")
            return
        self.binding = True
        self.lbl_tb.config(text="⏳按摇杆...", foreground="orange")

    def _save_c(self):
        self._save_profiles()
        try:
            tmp = CONFIG_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({
                    "play_guid": self.play_guid,
                    "rec_guid": self.rec_guid,
                    "hotkey_keys": self.hotkey_keys,
                    "mirror_key": self.mirror_key,
                    "active_profile_idx": self.active_profile_idx,
                    "monitor_on": getattr(self, 'var_mon', None) and self.var_mon.get(),
                    "win_geometry": self.win_geometry,
                    "target_window": self.target_window,
                    "sec_process": getattr(self, 'var_sec_proc', None) and self.var_sec_proc.get() or getattr(self, 'sec_process', "steam"),
                    "use_sec_proc": self.var_use_sec_proc.get() if hasattr(self, 'var_use_sec_proc') else getattr(self, 'use_sec_proc', True),
                    "sec_process_path": getattr(self, "sec_process_path", ""),
                    "btn_map": getattr(self, "btn_map", {}),
                    "saved_play_guid": getattr(self, "saved_play_guid", None),
                    "saved_play_name": getattr(self, "saved_play_name", ""),
                    "saved_rec_guid": getattr(self, "saved_rec_guid", None),
                    "saved_rec_name": getattr(self, "saved_rec_name", ""),
                    "sound_enabled": getattr(self, "sound_enabled", True),
                    "custom_templates": getattr(self, "custom_templates",[]),
                }, f, indent=2, ensure_ascii=False)
            os.replace(tmp, CONFIG_FILE)
        except Exception: pass

    def _load_cfg(self):
        self.sec_process = "steam"
        self.saved_play_guid = None
        self.saved_play_name = "未知设备"
        self.saved_rec_guid = None
        self.saved_rec_name = "未知设备"
        default_tpl = [
            ("→A",[{"type": "dir", "dir": "→右"}, {"type": "press", "btn": "A"}, {"type": "wait", "delay": 50}, {"type": "release", "btn": "A"}, {"type": "dir", "dir": "○中立"}]),
            ("↓B",[{"type": "dir", "dir": "↓下"}, {"type": "press", "btn": "B"}, {"type": "wait", "delay": 50}, {"type": "release", "btn": "B"}, {"type": "dir", "dir": "○中立"}]),
            ("→B",[{"type": "dir", "dir": "→右"}, {"type": "press", "btn": "B"}, {"type": "wait", "delay": 50}, {"type": "release", "btn": "B"}, {"type": "dir", "dir": "○中立"}]),
            ("↓A",[{"type": "dir", "dir": "↓下"}, {"type": "press", "btn": "A"}, {"type": "wait", "delay": 50}, {"type": "release", "btn": "A"}, {"type": "dir", "dir": "○中立"}]),
            ("→↓→A",[{"type": "dir", "dir": "→右"}, {"type": "wait", "delay": 30}, {"type": "dir", "dir": "↓下"}, {"type": "wait", "delay": 30}, {"type": "dir", "dir": "→右"}, {"type": "press", "btn": "A"}, {"type": "wait", "delay": 50}, {"type": "release", "btn": "A"}, {"type": "dir", "dir": "○中立"}])
        ]
        self.custom_templates = default_tpl
        self.active_profile_idx = -1
        try:
            c = json.load(open(CONFIG_FILE, encoding="utf-8"))
            self.saved_play_guid = c.get("saved_play_guid")
            self.saved_play_name = c.get("saved_play_name", "未知设备")
            self.saved_rec_guid = c.get("saved_rec_guid")
            self.saved_rec_name = c.get("saved_rec_name", "未知设备")
            
            self.play_guid = self.saved_play_guid
            self.rec_guid = self.saved_rec_guid
            
            # [B14修复] trigger_btn/trigger_macro_idx 的单一真源改为 profile
            # （见 _load_profiles / _save_profiles / _apply_profile），不再从 config.json
            # 冗余读取，避免两处不一致导致切换人物或崩溃强杀时配置丢失
            self.hotkey_binds = c.get("hotkey_binds", {s["id"]: -1 for s in HOTKEY_SLOTS})
            
            if "profiles" in c and c["profiles"]:
                self._legacy_profiles = c["profiles"]
                
            self.active_profile_idx = c.get("active_profile_idx", -1)
            
            sk = c.get("hotkey_keys", {})
            for slot in HOTKEY_SLOTS:
                if slot["id"] in sk: self.hotkey_keys[slot["id"]] = sk[slot["id"]]
            smk = c.get("mirror_key")
            if smk and "name" in smk and "scan_code" in smk: self.mirror_key = smk
            
            self.mirror = False
            self.sound_enabled = c.get("sound_enabled", True)
            self.monitor_on = c.get("monitor_on", False)
            self.win_geometry = c.get("win_geometry", "1060x900")
            self.target_window = c.get("target_window", "TEKKEN 8")
            self.sec_process = c.get("sec_process", "steam")
            self.use_sec_proc = c.get("use_sec_proc", True)
            self.sec_process_path = c.get("sec_process_path", "")
            
            # 还原按键锁死字典 (因为 JSON 只能存字符串键，需要转回数字)
            b_map = c.get("btn_map", {})
            self.btn_map = {int(k): v for k, v in b_map.items()}
            
            if "custom_templates" in c:
                self.custom_templates = c["custom_templates"]
        except Exception: pass

    def _save_profiles(self):
        if getattr(self, "active_profile_idx", -1) >= 0 and self.active_profile_idx < len(getattr(self, "profiles", [])):
            prof = self.profiles[self.active_profile_idx]
            prof["trigger_btn"] = getattr(self, "trigger_btn", -1)
            prof["trigger_macro_idx"] = getattr(self, "trigger_macro_idx", -1)
            prof["hotkey_binds"] = copy.deepcopy(getattr(self, "hotkey_binds", {}))
            
            data = copy.deepcopy(self.macros)
            for m in data:
                for s in m.get("steps",[]): s.pop("_orig", None)
            prof["macros"] = data

        try:
            tmp = PROFILES_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.profiles, f, indent=2, ensure_ascii=False)
            os.replace(tmp, PROFILES_FILE)
        except Exception: pass

    def _load_profiles(self):
        self.profiles = []
        try:
            self.profiles = json.load(open(PROFILES_FILE, encoding="utf-8"))
        except Exception:
            if hasattr(self, '_legacy_profiles'):
                self.profiles = self._legacy_profiles
                
        if not self.profiles:
            legacy_macros = []
            try:
                legacy_macros = json.load(open(os.path.join(BASE_DIR, "macros.json"), encoding="utf-8"))
            except Exception: pass
            
            self.profiles.append({
                "name": "全局默认",
                "trigger_btn": getattr(self, "trigger_btn", -1),
                "trigger_macro_idx": getattr(self, "trigger_macro_idx", -1),
                "hotkey_binds": getattr(self, "hotkey_binds", {s["id"]: -1 for s in HOTKEY_SLOTS}),
                "macros": legacy_macros
            })
            
        if self.active_profile_idx < 0 or self.active_profile_idx >= len(self.profiles):
            self.active_profile_idx = 0
            
        for p in self.profiles:
            if "macros" not in p: p["macros"] = []
            for m in p["macros"]:
                if "steps" in m and m["steps"]: m["steps"] = normalize_steps(m["steps"])
                elif "events" in m and m["events"]: m["steps"] = events_to_steps(m["events"])
                
        self._apply_profile(self.active_profile_idx)

    def _manual_load_macros(self):
        filepath = filedialog.askopenfilename(
            title="选择宏备份文件",
            initialdir=BASE_DIR,
            filetypes=[("JSON 文件", "*.json"), ("所有文件", "*.*")],
            parent=self.root
        )
        if not filepath:
            return
        
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                new_macros = json.load(f)
            
            if not isinstance(new_macros, list):
                raise ValueError("文件内容格式不正确！")
            
            self.macros = new_macros
            for m in self.macros:
                if "steps" in m and m["steps"]: m["steps"] = normalize_steps(m["steps"])
                elif "events" in m and m["events"]: m["steps"] = events_to_steps(m["events"])
            
            self._save_profiles()
            self._ref_list()
            
            filename = filepath.split("/")[-1]
            self._st(f"✅ 成功导入: {filename}")
        except Exception as e:
            messagebox.showerror("读取失败", f"无法读取选择的文件:\n{e}", parent=self.root)
            self._st("❌ 导入宏失败")

    def _st(self, t):
        def _update():
            try: self.lbl_st.config(text=t)
            except Exception: pass
        try: self.root.after(0, _update)
        except Exception: pass

    def on_close(self):
        self.alive = False
        if hasattr(self, "license_mgr"):
            self.license_mgr.shutdown()
        
        try:
            if ctypes.windll.user32.GetKeyState(0x91) & 0x0001:
                ctypes.windll.user32.keybd_event(0x91, 0, 0, 0)
                ctypes.windll.user32.keybd_event(0x91, 0, 2, 0)
        except Exception: pass
        
        try:
            if sys.platform == "win32":
                ctypes.windll.winmm.timeEndPeriod(1)
        except Exception: pass

        try: self.win_geometry = self.root.geometry()
        except Exception: pass
        self.recycle_bin.clear()
        self._save_c()
        self._save_profiles()
        try: keyboard.unhook_all()
        except Exception: pass
        try:
            if self.vpad:
                self.vpad.reset()
                self.vpad.update()
        except Exception: pass
        try:
            if self.play_joy: self.play_joy.quit()
            if self.rec_joy: self.rec_joy.quit()
            pygame.quit()
        except Exception: pass
        try: self.root.destroy()
        except Exception: pass

if __name__ == "__main__":
    try:
        root = tk.Tk()
        app = App(root)
        root.mainloop() if app.alive else None
    except Exception as e:
        tb = traceback.format_exc()
        with open("fatal.log", "w", encoding="utf-8") as f:
            f.write(tb)
        print("Wrote to fatal.log")
        try: messagebox.showerror("致命错误", f"{e}\n\n{tb}")
        except Exception: pass
