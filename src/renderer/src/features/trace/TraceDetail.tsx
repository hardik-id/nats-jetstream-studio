import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import type { TraceMessage } from '@shared/trace'
import { MessageDetail } from '../../components/MessageDetail'
import { Button } from '../../components/ui'
import { useGateway } from '../../gateway'
import { useDecoders } from '../../lib/decoders'
import { MessageConsumers } from '../messages/MessageConsumers'
import { openMessages } from '../shell/nav'

/**
 * The selected message of a trace: the same panel as the Messages screen, hosted here, with
 * "Open in Messages" and the consumers of the message's stream. A payload that was cut short is
 * read in full with the get-message API when asked for.
 */
export function TraceDetail({
  connId,
  message,
  onClose,
  onPrevious,
  onNext
}: {
  connId: string
  message: TraceMessage
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}): ReactNode {
  const gateway = useGateway()
  const decoders = useDecoders(connId)
  const [fullFor, setFullFor] = useState<string | null>(null)
  const id = `${message.stream}#${message.seq}`
  const wantFull = fullFor === id
  const full = useQuery({
    queryKey: ['message', connId, message.stream, message.seq, 'full'],
    queryFn: () => gateway.getMessage(connId, message.stream, message.seq),
    enabled: wantFull,
    staleTime: 60_000
  })
  // The stream's retention explains what its consumers' states mean (shared cache with the stream page).
  const info = useQuery({
    queryKey: ['stream', connId, message.stream],
    queryFn: () => gateway.streamInfo(connId, message.stream)
  })
  const shown = wantFull && full.data ? full.data : message
  return (
    <MessageDetail
      message={shown}
      decoders={decoders}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      onLoadFull={message.truncated && !(wantFull && full.data) ? () => setFullFor(id) : undefined}
      loadingFull={full.isFetching}
      actions={
        <Button
          size="sm"
          variant="ghost"
          title={`Show #${message.seq} in ${message.stream} on the Messages screen`}
          aria-label="Open in Messages"
          icon={<ExternalLink className="h-4 w-4" aria-hidden />}
          onClick={() => openMessages(connId, { stream: message.stream, seq: message.seq })}
        >
          Open in Messages
        </Button>
      }
      sections={
        info.data && (
          <MessageConsumers
            connId={connId}
            stream={message.stream}
            retention={info.data.config.retention}
            knownCount={info.data.state.consumer_count}
            message={message}
          />
        )
      }
    />
  )
}
