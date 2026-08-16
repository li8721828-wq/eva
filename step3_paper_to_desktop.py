# -*- coding: utf-8 -*-
"""Step 3: 将论文草稿规范化为 H1/H2/H3 层级，以 UTF-8 写入桌面 paper_llm_finetuning.md 并校验。"""
import os
import re
import sys

DRAFT = r'D:\github\eva\论文草稿.md'
OUT = r'C:\Users\苏\Desktop\paper_llm_finetuning.md'

with open(DRAFT, 'r', encoding='utf-8') as f:
    draft = f.read()

lines = draft.split('\n')
out_lines = []
for line in lines:
    if line.startswith('**摘要**：'):
        out_lines.append('## 摘要')
        out_lines.append('')
        out_lines.append(line[len('**摘要**：'):])
    elif line.startswith('**关键词**：'):
        out_lines.append('## 关键词')
        out_lines.append('')
        out_lines.append(line[len('**关键词**：'):])
    elif line.startswith('#### '):
        out_lines.append('### ' + line[5:])   # 收敛四级为三级小节
    else:
        out_lines.append(line)

text = '\n'.join(out_lines)
while '\n\n\n' in text:
    text = text.replace('\n\n\n', '\n\n')
text = text.rstrip('\n') + '\n'

with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(text)

# ---------- 校验 ----------
with open(OUT, 'r', encoding='utf-8') as f:
    back = f.read()

errors = []

# 1) 无乱码
if '\ufffd' in back:
    errors.append('包含替换符 U+FFFD（乱码）')
if '\ufffe' in back:
    errors.append('包含 U+FFFE')

# 2) 标题层级：仅 H1 标题 / H2 一级章节 / H3 二级小节
h1 = re.findall(r'^# (?!#).*$', back, re.M)
h2 = re.findall(r'^## (?!#).*$', back, re.M)
h3 = re.findall(r'^### (?!#).*$', back, re.M)
h4 = re.findall(r'^#### ', back, re.M)
if len(h1) != 1:
    errors.append('H1 数量=%d（应为 1）' % len(h1))
if h4:
    errors.append('H4 数量=%d（应为 0）' % len(h4))
if h1 and not h1[0].startswith('# 大语言模型微调技术研究综述'):
    errors.append('H1 标题不匹配: %r' % h1[0])

expected_h2 = ['## 摘要', '## 关键词', '## 1 引言', '## 2 研究背景', '## 3 微调方法分类',
               '## 4 指令微调与对齐', '## 5 数据准备与处理', '## 6 评测基准与方法',
               '## 7 挑战', '## 8 未来展望', '## 参考文献']
for h in expected_h2:
    if h not in back:
        errors.append('缺少 H2: ' + h)

# 3) 参考文献 [1]-[29] 齐全
for i in range(1, 30):
    if ('[%d] ' % i) not in back:
        errors.append('缺少参考文献 [%d]' % i)

# 4) 不截断：文件以 [29] AlpacaEval 条目结尾
if not back.rstrip('\n').endswith('https://github.com/tatsu-lab/alpaca_eval.'):
    errors.append('文件未以参考文献 [29] 结尾（可能截断）')

# 5) 内容无丢失：草稿正文行（去掉标题行）都应在新文件中逐字存在
draft_body = []
for line in lines:
    if line.startswith('**摘要**：'):
        draft_body.append(line[len('**摘要**：'):])
    elif line.startswith('**关键词**：'):
        draft_body.append(line[len('**关键词**：'):])
    elif line.startswith('#'):
        continue
    else:
        draft_body.append(line)

new_body = [line for line in back.split('\n') if not line.startswith('#')]
missing = [l for l in draft_body if l and l not in new_body]
if missing:
    errors.append('输出缺失内容 %d 行，示例: %r' % (len(missing), missing[:3]))

# 6) 字数与统计
cjk = len(re.findall(r'[\u4e00-\u9fff]', back))

print('OUT:', OUT)
print('exists:', os.path.exists(OUT), '| size:', os.path.getsize(OUT), 'bytes')
print('H1=%d H2=%d H3=%d H4=%d' % (len(h1), len(h2), len(h3), len(h4)))
print('CJK chars:', cjk)
print('head3:', [l for l in back.split('\n') if l.startswith('## ')][:3])
print('errors:', errors if errors else 'NONE')
print('RESULT:', 'PASS' if not errors else 'FAIL')
sys.exit(0 if not errors else 1)
