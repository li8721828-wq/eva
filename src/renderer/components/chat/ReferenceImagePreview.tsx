import { ImageOff, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatImageAttachment } from '../../../shared/types'
import { cn } from '@/lib/utils'
import { Dialog, DialogClose, DialogHeader, DialogTitle } from '@/components/ui/Dialog'

export function ReferenceImagePreview({ image, className }: { image: ChatImageAttachment; className?: string }) {
  const [source, setSource] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSource(null)
    setLoaded(false)
    setFailed(false)
    void window.eva.file.imagePreview(image.path).then((dataUrl) => {
      if (!cancelled) setSource(dataUrl)
    })
    return () => {
      cancelled = true
    }
  }, [image.path])

  if (failed) {
    return <ReferenceImageUnavailable className={className} />
  }

  if (!source) {
    return (
      <span className={cn('flex items-center justify-center bg-zinc-100 text-zinc-400', className)} aria-label={`Loading ${image.name}`}>
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    )
  }

  if (!loaded) {
    return (
      <span className={cn('relative flex items-center justify-center overflow-hidden bg-zinc-100 text-zinc-400', className)}>
        <img src={source} alt="" className="absolute inset-0 h-full w-full object-contain opacity-0" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    )
  }

  return (
    <>
      <button type="button" onClick={() => setExpanded(true)} className={cn('block overflow-hidden bg-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500', className)} title={`View ${image.name}`} aria-label={`View ${image.name}`}>
        <img src={source} alt={image.name} className="h-full w-full object-contain" />
      </button>
      <Dialog open={expanded} onOpenChange={setExpanded} className="max-w-4xl overflow-hidden p-0">
        <DialogClose onClose={() => setExpanded(false)} />
        <DialogHeader className="border-b border-zinc-100 px-5 py-4 pr-12">
          <DialogTitle className="text-base">{image.name}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[calc(100vh-10rem)] bg-zinc-950 p-4">
          <img src={source} alt={image.name} className="max-h-[calc(100vh-12rem)] w-full object-contain" />
        </div>
      </Dialog>
    </>
  )
}

export function ReferenceImageUnavailable({ className }: { className?: string }) {
  return <span className={cn('flex items-center justify-center bg-zinc-100 text-zinc-400', className)}><ImageOff className="h-4 w-4" /></span>
}
