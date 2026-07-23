import React, { useState } from 'react'
import type { SpecParameter } from '../../../shared/types/spec'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { AlertCircle, Play } from 'lucide-react'

export interface SpecParameterFormProps {
  parameters: SpecParameter[]
  onSubmit: (params: Record<string, string>) => void
  submitLabel?: string
}

export function SpecParameterForm({ parameters, onSubmit, submitLabel = 'Submit' }: SpecParameterFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const p of parameters) {
      initial[p.name] = p.type === 'select' ? (p.options?.[0] || '') : ''
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const handleChange = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    if (errors[name]) {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const handleBlur = (name: string) => {
    setTouched((prev) => ({ ...prev, [name]: true }))
    validateField(name)
  }

  const validateField = (name: string) => {
    const param = parameters.find((p) => p.name === name)
    if (!param) return
    if (param.required && !values[name]?.trim()) {
      setErrors((prev) => ({ ...prev, [name]: `${param.label} is required` }))
    } else {
      setErrors((prev) => {
        const next = { ...prev }
        delete next[name]
        return next
      })
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Validate all required fields
    const newErrors: Record<string, string> = {}
    for (const param of parameters) {
      if (param.required && !values[param.name]?.trim()) {
        newErrors[param.name] = `${param.label} is required`
      }
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      // Mark all required empty fields as touched
      const newTouched: Record<string, boolean> = {}
      for (const param of parameters) {
        if (param.required) newTouched[param.name] = true
      }
      setTouched((prev) => ({ ...prev, ...newTouched }))
      return
    }

    onSubmit(values)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="text-sm font-medium text-zinc-500 uppercase tracking-wider mb-2">
        Parameters
      </div>

      {parameters.map((param) => (
        <div key={param.name} className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-sm font-medium text-zinc-700">
            {param.label}
            {param.required && <span className="text-red-400 text-xs">*</span>}
          </label>

          {param.type === 'text' && (
            <Input
              value={values[param.name] || ''}
              onChange={(e) => handleChange(param.name, e.target.value)}
              onBlur={() => handleBlur(param.name)}
              placeholder={param.placeholder}
              aria-invalid={!!errors[param.name]}
            />
          )}

          {param.type === 'textarea' && (
            <Textarea
              value={values[param.name] || ''}
              onChange={(e) => handleChange(param.name, e.target.value)}
              onBlur={() => handleBlur(param.name)}
              placeholder={param.placeholder}
              className="min-h-[80px]"
              aria-invalid={!!errors[param.name]}
            />
          )}

          {param.type === 'select' && (
            <Select
              value={values[param.name] || ''}
              onChange={(e) => handleChange(param.name, e.target.value)}
              options={(param.options || []).map((opt) => ({
                value: opt,
                label: opt.charAt(0).toUpperCase() + opt.slice(1),
              }))}
            />
          )}

          {param.type === 'file' && (
            <Input
              type="text"
              value={values[param.name] || ''}
              onChange={(e) => handleChange(param.name, e.target.value)}
              onBlur={() => handleBlur(param.name)}
              placeholder={param.placeholder || 'Enter file path'}
            />
          )}

          {/* Error message */}
          {touched[param.name] && errors[param.name] && (
            <div className="flex items-center gap-1 text-xs text-red-500">
              <AlertCircle className="h-3 w-3" />
              {errors[param.name]}
            </div>
          )}
        </div>
      ))}

      <Button type="submit" className="w-full gap-2 mt-2">
        <Play className="h-4 w-4" />
        {submitLabel}
      </Button>
    </form>
  )
}
