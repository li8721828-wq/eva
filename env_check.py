# -*- coding: utf-8 -*-
"""Environment check: desktop path, Python, python-docx, pypandoc, pandoc."""
import sys
import os
import shutil
import platform
import subprocess

print("=" * 64)
print("ENVIRONMENT CHECK")
print("=" * 64)

print("\n[1] PYTHON")
print(f"  executable      : {sys.executable}")
print(f"  version         : {sys.version.splitlines()[0]}")
print(f"  platform        : {platform.platform()}")
print(f"  fs encoding     : {sys.getfilesystemencoding()}")
print(f"  default encoding: {sys.getdefaultencoding()}")

print("\n[2] TARGET DIRECTORY")
desktop = r"C:\Users\苏\Desktop"
print(f"  path  : {desktop}")
exists = os.path.exists(desktop)
print(f"  exists: {exists}")
if exists:
    print(f"  isdir : {os.path.isdir(desktop)}")
    try:
        entries = os.listdir(desktop)
        print(f"  listdir OK: {len(entries)} entries")
        for e in entries[:10]:
            print("    -", repr(e))
    except Exception as ex:
        print(f"  listdir FAILED: {type(ex).__name__}: {ex}")

print("\n[3] PYTHON PACKAGES")
for mod, ver_attr in (("docx", "__version__"), ("pypandoc", "__version__")):
    try:
        m = __import__(mod)
        v = getattr(m, ver_attr, "unknown")
        print(f"  {mod}: INSTALLED (version={v})")
    except ImportError as e:
        print(f"  {mod}: NOT INSTALLED ({e})")

print("\n[4] PANDOC")
print(f"  shutil.which('pandoc') -> {shutil.which('pandoc')}")
try:
    import pypandoc
    try:
        print(f"  pypandoc.get_pandoc_version() -> {pypandoc.get_pandoc_version()}")
    except Exception as e:
        print(f"  pypandoc.get_pandoc_version() FAILED: {type(e).__name__}: {e}")
        try:
            print(f"  pypandoc.get_pandoc_path() -> {pypandoc.get_pandoc_path()}")
        except Exception as e2:
            print(f"  pypandoc.get_pandoc_path() FAILED: {type(e2).__name__}: {e2}")
except ImportError:
    print("  pypandoc not importable; pandoc detection skipped")

try:
    res = subprocess.run(["pandoc", "--version"], capture_output=True, text=True, timeout=20)
    first = res.stdout.splitlines()[0] if res.stdout else res.stderr.splitlines()[0]
    print(f"  pandoc --version rc={res.returncode} -> {first}")
except Exception as e:
    print(f"  pandoc --version FAILED: {type(e).__name__}: {e}")

print("\n" + "=" * 64)
print("CHECK COMPLETE")
print("=" * 64)
