import { Button } from '@/components/ui/Button'
import { useChatStore } from '@/stores/use-chat-store'
import { MessageSquarePlus } from 'lucide-react'
import evaMark from '@/assets/eva-mark.svg'

export interface WelcomeScreenProps {
  className?: string
}

export function WelcomeScreen({ className }: WelcomeScreenProps) {
  const { createConversation } = useChatStore()

  return (
    <div className={`flex h-full flex-col items-center justify-center px-6 ${className || ''}`}>
      <div className="flex w-full max-w-lg flex-col items-center gap-4 px-4 text-center">
        <img src={evaMark} alt="Eva" className="h-12 w-12" />
        <h1 className="text-2xl font-bold text-zinc-900">Welcome to Eva</h1>
        <div className="mt-4 flex items-center justify-center">
          <Button className="gap-2" onClick={() => createConversation()}>
            <MessageSquarePlus className="h-4 w-4" />
            New conversation
          </Button>
        </div>
      </div>
    </div>
  )
}
