import type { AppLanguage } from '@/stores/use-app-store'

const labels: Record<string, readonly [string, string]> = {
  "Task workspace": [
    "本次执行",
    "今回の実行"
  ],
  "Ready": [
    "等待任务",
    "待機中"
  ],
  "Queued": [
    "排队中",
    "待機中"
  ],
  "In progress": [
    "进行中",
    "実行中"
  ],
  "Stopped": [
    "已停止",
    "停止済み"
  ],
  "Complete": [
    "已完成",
    "完了"
  ],
  "Completed": [
    "已完成",
    "完了"
  ],
  "Failed": [
    "失败",
    "失敗"
  ],
  "Cancelled": [
    "已取消",
    "キャンセル済み"
  ],
  "Waiting": [
    "待开始",
    "未着手"
  ],
  "Needs attention": [
    "需要处理",
    "対応が必要"
  ],
  "No task plan yet": [
    "暂无执行计划",
    "実行計画はありません"
  ],
  "Generated documents": [
    "生成的文档",
    "生成された文書"
  ],
  "Browse files": [
    "查看文件",
    "ファイルを見る"
  ],
  "Task outline": [
    "执行步骤",
    "実行手順"
  ],
  "Eva is preparing the task plan.": [
    "Eva 正在准备执行计划。",
    "Eva が実行計画を準備しています。"
  ],
  "Continue": [
    "继续执行",
    "続行"
  ],
  "Stop": [
    "暂停",
    "一時停止"
  ],
  "Cancel": [
    "取消任务",
    "タスクをキャンセル"
  ],
  "Working...": [
    "处理中…",
    "処理中…"
  ],
  "Cancelling...": [
    "正在取消…",
    "キャンセル中…"
  ],
  "Continue this task": [
    "继续执行此任务",
    "このタスクを続行"
  ],
  "Stop after the current operation": [
    "当前操作结束后暂停",
    "現在の操作後に一時停止"
  ],
  "Cancel this task": [
    "取消此任务",
    "このタスクをキャンセル"
  ],
  "Cancel this task? Its current execution cannot be continued.": [
    "取消此任务？取消后无法继续当前执行。",
    "このタスクをキャンセルしますか？現在の実行は再開できなくなります。"
  ],
  "Hidden Goal step conversation": [
    "独立的任务步骤会话",
    "独立したステップ会話"
  ],
  "This conversation is scoped to one Goal step and is hidden from the left conversation list.": [
    "此会话只处理一个任务步骤，不会出现在左侧会话列表。",
    "この会話は1つのステップを処理し、左側の一覧には表示されません。"
  ],
  "Back to parent task": [
    "返回主任务",
    "親タスクに戻る"
  ],
  "Open this step conversation": [
    "查看此步骤会话",
    "このステップの会話を開く"
  ],
  "Retry history": [
    "重试记录",
    "再試行の履歴"
  ],
  "Connection failed": [
    "连接失败",
    "接続に失敗"
  ],
  "Retry in progress": [
    "正在重试",
    "再試行中"
  ],
  "Result": [
    "执行结果",
    "実行結果"
  ],
  "Execution activity": [
    "执行活动",
    "実行履歴"
  ],
  "Execution records will appear here as this step progresses.": [
    "此步骤开始执行后，实际操作记录会显示在这里。",
    "ステップの開始後、実際の操作履歴を表示します。"
  ],
  "Show less": [
    "收起",
    "折りたたむ"
  ],
  "Conversation usage": [
    "本次会话用量",
    "会話の使用量"
  ],
  "Token, cache, and context information for this conversation.": [
    "查看当前会话的 Token、缓存与上下文用量。",
    "この会話のトークン、キャッシュ、コンテキスト使用量です。"
  ],
  "No usage recorded yet": [
    "暂无用量记录",
    "使用量の記録はありません"
  ],
  "Usage appears after the first model response is complete.": [
    "模型首次回复完成后显示用量。",
    "最初のモデル応答後に使用量を表示します。"
  ],
  "Token volume": [
    "Token 用量",
    "トークン使用量"
  ],
  "Total": [
    "总计",
    "合計"
  ],
  "Input": [
    "输入",
    "入力"
  ],
  "Output": [
    "输出",
    "出力"
  ],
  "Latest model": [
    "最近使用的模型",
    "最新のモデル"
  ],
  "Unknown": [
    "未知",
    "不明"
  ],
  "Prompt cache": [
    "输入缓存",
    "入力キャッシュ"
  ],
  "Cached input": [
    "命中缓存",
    "キャッシュ済み入力"
  ],
  "Uncached input": [
    "未命中缓存",
    "未キャッシュ入力"
  ],
  "Current context": [
    "当前上下文",
    "現在のコンテキスト"
  ],
  "Show task plan": [
    "查看执行计划",
    "実行計画を表示"
  ],
  "Show conversation usage": [
    "查看会话用量",
    "会話の使用量を表示"
  ],
  "Select a document from Files to preview it here.": [
    "从文件列表选择文档，在这里预览。",
    "ファイル一覧から文書を選択すると、ここでプレビューできます。"
  ],
  "Could not stop this task.": [
    "暂停失败，请重试。",
    "一時停止できませんでした。"
  ],
  "Could not continue this task.": [
    "继续执行失败，请重试。",
    "続行できませんでした。"
  ],
  "Could not cancel this task.": [
    "取消失败，请重试。",
    "キャンセルできませんでした。"
  ],
  "No generated documents yet.": [
    "暂无生成的文档。",
    "生成された文書はありません。"
  ]
}

export function workspaceText(language: AppLanguage, text: string): string {
  return language === 'en' ? text : labels[text]?.[language === 'zh' ? 0 : 1] ?? text
}
