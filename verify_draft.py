# -*- coding: utf-8 -*-
"""Step 2 校验：论文草稿的正文字数、引用编号完整性与章节结构。"""
import io
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PATH = r"D:\github\eva\论文草稿.md"


def cjk_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def main() -> None:
    with io.open(PATH, encoding="utf-8") as f:
        s = f.read()
    body, _, refs = s.partition("## 参考文献")

    body_cjk = cjk_count(body)
    refs_cjk = cjk_count(refs)
    total_cjk = cjk_count(s)
    print("file_size_bytes :", len(s.encode("utf-8")))
    print("body_cjk_chars  :", body_cjk)
    print("refs_cjk_chars  :", refs_cjk)
    print("total_cjk_chars :", total_cjk)
    print("body_len_ok     :", 8000 <= body_cjk <= 12000)

    cites = sorted(set(int(x) for x in re.findall(r"\[(\d+)\]", body)))
    ref_ids = sorted(set(int(x) for x in re.findall(r"^\[(\d+)\]", refs, re.M)))
    print("cited_in_text   :", cites)
    print("ref_list        :", ref_ids)
    print("cited_not_in_list :", sorted(set(cites) - set(ref_ids)))
    print("in_list_not_cited :", sorted(set(ref_ids) - set(cites)))
    print("ref_count       :", len(ref_ids))

    secs = re.findall(r"^#{1,3} .*$", s, re.M)
    print("sections        :", len(secs))
    for h in secs:
        print("  " + h)

    bad = s.count("\ufffd")
    print("replacement_chars:", bad)
    print("RESULT:", "PASS" if (8000 <= body_cjk <= 12000 and bad == 0) else "FAIL")


if __name__ == "__main__":
    main()
