# -*- coding: utf-8 -*-
"""Step 4 independent reconfirmation of C:\\Users\\苏\\Desktop\\paper_llm_finetuning.md"""
import os, re, sys, unicodedata

PATH = r"C:\Users\苏\Desktop\paper_llm_finetuning.md"

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL"), "-", name, ("| " + detail if detail else ""))

# 1. existence + decode
print("== 1. file existence / utf-8 decode ==")
if not os.path.exists(PATH):
    check("file exists", False, "missing: " + PATH)
    sys.exit(1)
raw = open(PATH, "rb").read()
check("file exists", True, "size=%d bytes" % len(raw))
try:
    text = raw.decode("utf-8")
    check("utf-8 decode", True, "chars=%d" % len(text))
except UnicodeDecodeError as e:
    check("utf-8 decode", False, str(e)); sys.exit(1)

# 2. replacement / control characters
print("== 2. replacement & illegal chars ==")
fffd = text.count("\ufffd") + text.count("\ufffe")
check("no replacement chars (U+FFFD/U+FFFE)", fffd == 0, "count=%d" % fffd)
ctrl = [c for c in text if unicodedata.category(c) == "Cc" and c not in "\n\r\t"]
check("no stray control chars", len(ctrl) == 0, "count=%d" % len(ctrl))

# 3. required sections (headings)
print("== 3. required sections ==")
lines = text.splitlines()
headings = [l for l in lines if re.match(r"^#{1,4}\s", l)]
h2s = [h for h in headings if h.startswith("## ")]
required = ["摘要", "关键词", "引言", "研究背景", "微调方法分类", "指令微调与对齐",
            "数据准备与处理", "评测基准与方法", "挑战", "未来展望", "参考文献"]
missing = [r for r in required if not any(r in h for h in h2s)]
check("all %d required H2 sections present" % len(required), not missing, "missing=%s" % missing)
print("H2 sections:", len(h2s))
for h in h2s:
    print("   ", h)

# 4. references [1]-[29]
print("== 4. references [1]-[29] ==")
ref_lines = [l for l in lines if re.match(r"^\[\d+\]\s", l)]
ref_nums = sorted(int(re.match(r"^\[(\d+)\]", l).group(1)) for l in ref_lines)
refs_ok = ref_nums == list(range(1, 30))
check("references [1]-[29] all present, in order", refs_ok,
      "found=%d (%s...%s)" % (len(ref_nums), ref_nums[0] if ref_nums else "-", ref_nums[-1] if ref_nums else "-"))
# tail = last non-empty line; must be the [29] entry, i.e. no truncation
tail = [l for l in lines if l.strip()][-1]
check("file ends with reference [29] entry (no truncation)", tail.startswith("[29]"), tail[:90] + ("..." if len(tail) > 90 else ""))
# body citations 1..29 all appear in text
missing_cite = [i for i in range(1, 30) if ("[%d]" % i) not in text]
check("in-text citations [1]-[29] present", not missing_cite, "missing=%s" % missing_cite)

# 5. CJK counts
print("== 5. CJK character counts ==")
def cjk_count(s):
    return len([ch for ch in s if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"])
total_cjk = cjk_count(text)
# body: exclude heading lines and reference list
ref_start = next(i for i, l in enumerate(lines) if l.startswith("## 参考文献"))
body_lines = [l for i, l in enumerate(lines) if i < ref_start and not re.match(r"^#{1,4}\s", l)]
body_cjk = cjk_count("\n".join(body_lines))
check("CJK in range 8000-12000 (body, excl. headings+refs)", 8000 <= body_cjk <= 12000,
      "body CJK=%d" % body_cjk)
check("CJK in range 8000-12000 (whole file)", 8000 <= total_cjk <= 12000, "total CJK=%d" % total_cjk)

# 6. heading hierarchy sanity
print("== 6. heading hierarchy ==")
levels = {}
for l in headings:
    n = len(l) - len(l.lstrip("#"))
    levels[n] = levels.get(n, 0) + 1
check("only H1/H2/H3 levels", set(levels) <= {1, 2, 3}, "levels=%s" % sorted(levels.items()))

failed = [n for n, ok, _ in results if not ok]
print("\n==== RESULT: %s ====" % ("PASS" if not failed else "FAIL: " + ", ".join(failed)))
print("body CJK=%d, total CJK=%d, bytes=%d, H2=%d, refs=%d" % (body_cjk, total_cjk, len(raw), len(h2s), len(ref_nums)))
