# STEP5_REPORT.md — Step 5 Word 文档生成报告

## 结果: PASS

**输入**：`C:\Users\苏\Desktop\paper_llm_finetuning.md`（Markdown，UTF-8）
**输出**：`C:\Users\苏\Desktop\paper_llm_finetuning.docx`（python-docx 1.2.0，51.8 KB，53046 字节）

## 实际数据

| 项目 | 实测值 |
| --- | --- |
| 总段落数 | 95 |
| Title（论文标题） | 1 |
| Heading 1（一级章节：摘要/关键词/1-8 章/参考文献） | 11 |
| Heading 2（二级小节） | 23 |
| Heading 3（预留，本文档无更深标题） | 0 |
| 正文段落（Normal，含参考文献） | 60 |
| 参考文献 [1]-[29] | 29 条，编号按序完整 |
| 3.3 节对比表 | 1 张，6 行 x 6 列（表头+5 种方法） |
| 全文汉字数 | 8370 |
| 东亚字体（document.xml 中 w:eastAsia） | 宋体 x96，黑体 x35 |
| Markdown 残留（# / |） | 0 |

## 校验项

共 15 项检查，全部通过。标题层级映射：H1→Title、H2→Heading 1、H3→Heading 2（Heading 3 已配置备用）；标题文本、正文段落、参考文献文本均与 Markdown 逐条一致；表格 6x6 内容一致。排版：A4 页面（上下 2.54cm、左右 3.17cm）；正文宋体五号 10.5pt、1.5 倍行距、首行缩进 2 字符（w:firstLineChars=200）；标题黑体加粗黑色；西文 Times New Roman；参考文献 9pt 悬挂缩进。
