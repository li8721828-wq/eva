# -*- coding: utf-8 -*-
"""Step 6: 最终确认与报告
验证：文件路径位于桌面、文件名完全为 大模型学习路线.md、
Markdown 格式正确（标题以 # 开头）、14 个章节顺序排列有序。
输出验证摘要：文件路径、文件大小、检查通过的章节数量。
"""
import os
import re
import sys
import subprocess

EXPECTED_FILENAME = "大模型学习路线.md"
EXPECTED_TITLE = "# 大模型学习路线（完整版）"

# 14 个章节标题（按文档实际顺序，来自 read_file 独立核对）
EXPECTED_CHAPTERS = [
    "一、引言",
    "二、前置基础",
    "三、机器学习与深度学习基础",
    "四、Transformer 与注意力机制原理",
    "五、主流大模型架构与代表模型",
    "六、预训练与数据工程",
    "七、微调：SFT、LoRA/QLoRA、RLHF、DPO",
    "八、提示工程（Prompt Engineering）",
    "九、RAG 检索增强生成",
    "十、Agent 智能体",
    "十一、推理优化与部署",
    "十二、模型评测方法",
    "十三、分阶段学习路线图与实战项目",
    "十四、学习资源推荐",
]

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" | {detail}" if detail else ""))


# ---------- 1. 桌面路径（多来源） ----------
desktop_py = os.path.join(os.path.expanduser("~"), "Desktop")
desktop_ps = ""
try:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "[Environment]::GetFolderPath('Desktop')"],
        capture_output=True, text=True, timeout=30
    )
    desktop_ps = out.stdout.strip()
except Exception:
    pass

desktop = desktop_py
check("桌面路径确认", os.path.isdir(desktop_py),
      f"{desktop_py}（存在）" + (f"；PowerShell 一致: {desktop_ps}" if desktop_ps == desktop_py else ""))

# ---------- 2. 目标文件存在性与绝对路径 ----------
target = os.path.join(desktop, EXPECTED_FILENAME)
abs_path = os.path.abspath(target)
exists = os.path.exists(target)
check("文件存在", exists, abs_path)

# ---------- 3. 文件名完全一致 ----------
basename = os.path.basename(target)
name_ok = basename == EXPECTED_FILENAME
check("文件名完全为 大模型学习路线.md", name_ok, f"实际: {basename}")

# ---------- 4. 路径位于桌面 ----------
on_desktop = os.path.dirname(abs_path).lower() == desktop.lower()
check("路径位于桌面", on_desktop and exists, f"目录: {os.path.dirname(abs_path)}")

# ---------- 5. 文件大小 ----------
size = os.path.getsize(target) if exists else 0
size_ok = size >= 8 * 1024
check("文件大小 >= 8 KB", size_ok, f"{size} 字节 ({size / 1024:.1f} KB)")

# ---------- 6. Markdown 格式与章节顺序 ----------
if exists:
    with open(target, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    heading_re = re.compile(r"^(#{1,6})\s+\S")
    headings = []          # (line_no, level, text)
    for i, line in enumerate(lines, 1):
        m = heading_re.match(line)
        if m:
            level = len(m.group(1))
            headings.append((i, level, line.strip()))

    # 6a. 首行必须是 H1 标题
    first_ok = headings and headings[0][1] == 1 and headings[0][2] == EXPECTED_TITLE
    check("首行 H1 标题", first_ok,
          f"第 {headings[0][0]} 行: {headings[0][2]}" if headings else "无标题")

    # 6b. 所有标题均以 # 开头（正则已保证）且层级 <= 4
    bad_levels = [h for h in headings if h[1] > 4]
    check("标题层级规范（# 至 ####）", not bad_levels, f"共 {len(headings)} 个标题")

    # 6c. 章节顺序：从 "一、引言" 到 "十四、学习资源推荐" 按序出现
    h2_texts = [h[2].lstrip("# ").strip() for h in headings if h[1] == 2]
    idx = 0
    chapter_positions = []
    for ch in EXPECTED_CHAPTERS:
        # 章节标题是 ## 的正文部分（去掉 "## " 前缀后应完全等于章节名）
        found_at = None
        for j in range(idx, len(h2_texts)):
            if h2_texts[j] == ch:
                found_at = j
                break
        if found_at is None:
            chapter_positions.append((ch, None))
            break
        chapter_positions.append((ch, found_at))
        idx = found_at + 1

    chapters_ok = len(chapter_positions) == len(EXPECTED_CHAPTERS) and \
        all(pos is not None for _, pos in chapter_positions) and \
        [c for c, _ in chapter_positions] == EXPECTED_CHAPTERS
    check("14 个章节按序排列", chapters_ok,
          f"检查通过 {sum(1 for _, p in chapter_positions if p is not None)}/{len(EXPECTED_CHAPTERS)}")

    # 6d. 目录 (TOC) 存在且位于引言之前
    toc_ok = h2_texts and h2_texts[0] == "目录"
    check("目录章节存在且置首", toc_ok)

    # 6e. 三级标题数量（正文小节）
    h3_count = sum(1 for h in headings if h[1] == 3)
    check("三级小节标题", h3_count > 0, f"{h3_count} 个")

    # 6f. 代码块完整性（``` 围栏成对）
    fence_lines = [l for l in lines if l.strip().startswith("```")]
    code_ok = len(fence_lines) % 2 == 0
    check("代码块成对闭合", code_ok,
          f"{len(fence_lines)} 个围栏行（{len(fence_lines) // 2} 个代码块，{'成对' if code_ok else '不成对'}）")
else:
    chapters_ok = False
    check("章节检查", False, "文件不存在，跳过")
    check("目录章节存在且置首", False)
    check("三级小节标题", False)
    check("代码块成对闭合", False)

# ---------- 7. 汇总 ----------
all_ok = all(ok for _, ok, _ in results)
print("\n===== 验证摘要 =====")
print(f"文件路径 : {abs_path}")
print(f"文件大小 : {size} 字节 ({size / 1024:.1f} KB)")
print(f"总标题数 : {len(headings)}（H1: 1, H2: {sum(1 for h in headings if h[1] == 2)}, H3: {sum(1 for h in headings if h[1] == 3)}）")
print(f"章节检查 : 通过 {sum(1 for _, p in chapter_positions if p is not None)}/{len(EXPECTED_CHAPTERS)} 个章节")
print(f"总体判定 : {'RESULT: PASS' if all_ok else 'RESULT: FAIL'}")
sys.exit(0 if all_ok else 1)
