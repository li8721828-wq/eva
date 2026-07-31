import React from 'react'
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog'
import { AgentManagementWorkspace } from './AgentManagementWorkspace'

export interface AgentManagerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Kept for the compact sidebar shortcut. Settings embeds the same workspace
 * directly, so both entry points remain consistent without duplicating logic.
 */
export function AgentManagerDialog({ open, onOpenChange }: AgentManagerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} className="max-w-6xl">
      <DialogClose onClose={() => onOpenChange(false)} />
      <DialogHeader>
        <DialogTitle>Agents</DialogTitle>
        <DialogDescription>Configure specialist roles, their model connections, and atomic tool access.</DialogDescription>
      </DialogHeader>
      <div className="-mx-6 -mb-6 mt-2 min-h-[600px]">
        <AgentManagementWorkspace />
      </div>
    </Dialog>
  )
}
