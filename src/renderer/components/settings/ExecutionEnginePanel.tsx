import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useAppStore } from '@/stores/use-app-store'
import {
  DEFAULT_EXECUTION_ENGINE,
  isExecutionEngineConfig,
  type ExecutionEngineConfig,
} from '../../../shared/types/execution-engine'

const copy = {
  zh: {
    title: '执行引擎',
    hint: 'Pi / Harness 使用原生提示词、上下文和核心工具；Eva 保留界面、模型连接与权限审批。保存后用于新开始的运行，当前运行继续使用原引擎。',
    label: '底层引擎',
    node: 'Node.js 可执行文件',
    runtime:
      'Pi 和 DeepSeek Harness 需要 Node.js 22.19 或更新版本。填写 node 或可执行文件的完整路径；模型和工具权限沿用 Eva 的配置。',
    preview: 'DeepSeek Harness 为开发预览版本，建议先在可恢复的任务中试用。',
    save: '保存执行引擎',
    saved: '已保存，将用于下一次运行',
    loading: '正在读取执行引擎设置…',
    retry: '重试读取',
  },
  en: {
    title: 'Execution engine',
    hint: 'Pi / Harness own their prompts, context and core tools. Eva provides the UI, model connection and permission checks. Saved changes apply to new runs.',
    label: 'Engine',
    node: 'Node.js executable',
    runtime:
      'Pi and DeepSeek Harness require Node.js 22.19 or newer. Enter node or the full executable path. Eva model settings and tool permissions apply.',
    preview:
      'DeepSeek Harness is a developer preview. Try it on recoverable tasks first.',
    save: 'Save engine',
    saved: 'Saved for the next run',
    loading: 'Loading engine settings…',
    retry: 'Retry loading',
  },
  ja: {
    title: '実行エンジン',
    hint: 'Pi / Harness 独自のプロンプト・文脈・基本ツールを使用します。画面・モデル接続・権限確認は Eva が担当します。保存後、新しい実行から適用されます。',
    label: 'エンジン',
    node: 'Node.js 実行ファイル',
    runtime:
      'Pi と DeepSeek Harness は Node.js 22.19 以降が必要です。node または実行ファイルのフルパスを指定します。モデルとツール権限は Eva の設定を使用します。',
    preview:
      'DeepSeek Harness は開発プレビュー版です。復元可能なタスクで試してください。',
    save: '保存',
    saved: '次回の実行用に保存しました',
    loading: '設定を読み込み中…',
    retry: '再読み込み',
  },
}

export function ExecutionEnginePanel() {
  const language = useAppStore((state) => state.language)
  const text = copy[language]
  const [draft, setDraft] = useState<ExecutionEngineConfig>(
    DEFAULT_EXECUTION_ENGINE,
  )
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const stored =
        await window.eva.config.get<ExecutionEngineConfig>('executionEngine')
      setDraft(
        isExecutionEngineConfig(stored) ? stored : DEFAULT_EXECUTION_ENGINE,
      )
      setLoaded(true)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  const save = async () => {
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await window.eva.config.set('executionEngine', {
        ...draft,
        nodePath: draft.nodePath.trim(),
      })
      setSaved(true)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <section
      className="settings-form-section"
      aria-labelledby="execution-engine-title"
    >
      <h3 id="execution-engine-title" className="settings-form-section-title">
        {text.title}
      </h3>
      <p className="text-sm text-zinc-500">{text.hint}</p>
      {loading ? (
        <p role="status" className="text-sm text-zinc-500">
          {text.loading}
        </p>
      ) : loaded ? (
        <>
          <div className="settings-dialog__field">
            <label htmlFor="execution-engine" className="settings-field-label">
              {text.label}
            </label>
            <Select
              id="execution-engine"
              value={draft.id}
              disabled={saving}
              options={[
                { value: 'eva', label: 'Eva' },
                { value: 'pi', label: 'Pi Agent' },
                { value: 'deepseek-harness', label: 'DeepSeek Harness' },
              ]}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  id: event.target.value as ExecutionEngineConfig['id'],
                })
                setSaved(false)
              }}
            />
          </div>
          {draft.id !== 'eva' && (
            <div className="settings-dialog__field">
              <label
                htmlFor="execution-engine-node"
                className="settings-field-label"
              >
                {text.node}
              </label>
              <Input
                id="execution-engine-node"
                value={draft.nodePath}
                disabled={saving}
                onChange={(event) => {
                  setDraft({ ...draft, nodePath: event.target.value })
                  setSaved(false)
                }}
              />
              <p className="text-xs text-zinc-500">{text.runtime}</p>
              <label
                htmlFor="execution-engine-budget"
                className="settings-field-label"
              >
                {language === 'zh'
                  ? '原生运行请求上限'
                  : language === 'ja'
                    ? 'モデル呼び出し上限'
                    : 'Native model-call limit'}
              </label>
              <Input
                id="execution-engine-budget"
                type="number"
                min={1}
                max={10000}
                value={draft.maxModelCalls ?? 1000}
                disabled={saving}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    maxModelCalls: Number(event.target.value),
                  })
                  setSaved(false)
                }}
              />
              <label
                htmlFor="execution-engine-output"
                className="settings-field-label"
              >
                {language === 'zh'
                  ? '单次响应 Token 上限'
                  : language === 'ja'
                    ? '応答トークン上限'
                    : 'Response token limit'}
              </label>
              <Input
                id="execution-engine-output"
                type="number"
                min={256}
                max={131072}
                value={draft.maxOutputTokens ?? 16384}
                disabled={saving}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    maxOutputTokens: Number(event.target.value),
                  })
                  setSaved(false)
                }}
              />
              {draft.id === 'deepseek-harness' && (
                <p className="text-xs text-zinc-500">{text.preview}</p>
              )}
            </div>
          )}
          <Button
            className="justify-self-start"
            onClick={() => void save()}
            disabled={saving || !isExecutionEngineConfig(draft)}
          >
            {text.save}
          </Button>
          {saved && (
            <p role="status" className="text-sm text-zinc-500">
              {text.saved}
            </p>
          )}
        </>
      ) : (
        <Button onClick={() => void load()}>{text.retry}</Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  )
}
