# -*- coding: utf-8 -*-
"""Step 5: 验证 大模型学习路线.md 的关键主题关键字是否齐全。"""
import io, os, sys

TARGET = r"C:\Users\苏\Desktop\大模型学习路线.md"

KEYWORDS = [
    "前置基础",
    "机器学习与深度学习",
    "Transformer",
    "GPT",
    "LLaMA",
    "DeepSeek",
    "Qwen",
    "Claude",
    "Gemini",
    "预训练",
    "LoRA",
    "RLHF",
    "DPO",
    "RAG",
    "Agent",
    "vLLM",
    "量化",
    "蒸馏",
    "评测",
    "3 个月",
    "6 个月",
    "12 个月",
    "学习资源",
]

def main():
    if not os.path.exists(TARGET):
        print("RESULT: FAIL (file missing)")
        sys.exit(1)
    with io.open(TARGET, "r", encoding="utf-8") as f:
        content = f.read()
    lines = content.splitlines()
    missing = []
    found = {}
    for kw in KEYWORDS:
        if kw in content:
            found[kw] = True
        else:
            missing.append(kw)
    print("total_lines:", len(lines))
    print("total_chars:", len(content))
    print("keywords_found: %d/%d" % (len(found), len(KEYWORDS)))
    for kw in KEYWORDS:
        print(("OK  " if kw in found else "MISS") + " " + kw)
    if missing:
        print("MISSING:", ", ".join(missing))
        print("RESULT: FAIL")
        sys.exit(2)
    print("RESULT: PASS")

if __name__ == "__main__":
    main()
