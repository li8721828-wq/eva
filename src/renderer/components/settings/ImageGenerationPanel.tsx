import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Image as ImageIcon, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { settingsDetailText } from '@/lib/settings-detail-copy'
import { useAppStore } from '@/stores/use-app-store'
import type { ImageGenerationConfig, ProviderConfigEntry } from '../../../shared/types/provider'

const MODEL_DATALIST_ID = 'image-generation-models'

export function ImageGenerationPanel({ providers }: { providers: ProviderConfigEntry[] }) {
  const language = useAppStore((state) => state.language)
  const t = (text: string) => settingsDetailText(language, text)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.isEnabled && Boolean(provider.apiKey.trim())),
    [providers],
  )
  const selectedProvider = selectableProviders.find((provider) => provider.id === providerId)
  const modelSuggestions = useMemo(() => {
    const ids = [...(selectedProvider?.models || []).map((item) => item.id)]
    if (selectedProvider?.defaultModel) ids.unshift(selectedProvider.defaultModel)
    return Array.from(new Set(ids.filter(Boolean)))
  }, [selectedProvider])

  useEffect(() => {
    let cancelled = false
    void window.eva.config.get<ImageGenerationConfig | undefined>('imageGeneration').then((config) => {
      if (cancelled) return
      setProviderId(config?.providerId || '')
      setModel(config?.model || '')
    }).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const persist = async (next: ImageGenerationConfig) => {
    if (saving) return
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await window.eva.config.set('imageGeneration', next)
      setProviderId(next.providerId)
      setModel(next.model)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const save = () => {
    if (!providerId || !selectedProvider) {
      setError(t('Choose a saved connection for image generation.'))
      return
    }
    if (!model.trim()) {
      setError(t('Enter the image model ID this connection should use.'))
      return
    }
    void persist({ providerId, model: model.trim() })
  }

  const clear = () => void persist({ providerId: '', model: '' })

  return (
    <section className="settings-image-generation mt-12" aria-label={t('Image generation')}>
      <fieldset disabled={saving} className="min-w-0">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-800">
            <ImageIcon className="h-4 w-4 text-violet-600" /> {t('Image generation')}
          </div>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {t('The generate_image tool uses this connection and model. It is independent of the chat model, so an image model never has to support tool calls.')}
          </p>
        </div>

        <div className="eva-panel mt-4 grid gap-3 p-4 md:grid-cols-2">
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium text-zinc-500" htmlFor="image-generation-provider">{t('Connection')}</label>
            <Select
              id="image-generation-provider"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              options={[
                { value: '', label: t('Not configured') },
                ...selectableProviders.map((provider) => ({ value: provider.id, label: provider.name })),
              ]}
            />
            {providerId && !selectedProvider && (
              <p className="mt-1 text-xs text-amber-700">{t('This connection is missing, disabled, or has no API key. Choose another connection.')}</p>
            )}
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs font-medium text-zinc-500" htmlFor="image-generation-model">{t('Model')}</label>
            <Input
              id="image-generation-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              list={MODEL_DATALIST_ID}
              placeholder={t('For example gpt-image-1')}
              disabled={!providerId}
            />
            <datalist id={MODEL_DATALIST_ID}>
              {modelSuggestions.map((id) => <option key={id} value={id} />)}
            </datalist>
          </div>
        </div>

        {!selectableProviders.length && (
          <p className="mt-3 text-xs text-amber-700">{t('Save a connection with an API key before configuring image generation.')}</p>
        )}
        {error && <div role="alert" className="mt-3 text-sm text-red-600">{error}</div>}

        <div className="mt-4 flex items-center justify-end gap-2">
          {saved && (
            <span className="mr-1 inline-flex items-center gap-1 text-xs text-emerald-700">
              <CheckCircle2 className="h-3.5 w-3.5" /> {t('Saved')}
            </span>
          )}
          {(providerId || model) && (
            <Button variant="ghost" size="sm" className="gap-1.5 text-zinc-500" onClick={clear}>
              <Trash2 className="h-3.5 w-3.5" /> {t('Clear')}
            </Button>
          )}
          <Button size="sm" className="gap-1.5" onClick={save} disabled={saving || !providerId || !model.trim()}>
            <Save className="h-3.5 w-3.5" /> {saving ? t('Saving...') : t('Save image settings')}
          </Button>
        </div>
      </fieldset>
    </section>
  )
}
