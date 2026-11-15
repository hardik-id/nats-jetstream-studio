import { useMemo, useState, type ReactNode } from 'react'
import { FileUp, Plus, Trash2 } from 'lucide-react'
import { validateSubject } from '@shared/subject'
import { Button, Card, ErrorNote, Input, Notice, Page, Select } from '../../components/ui'
import {
  buildProtoDecoders,
  EMPTY_PROTO,
  protoSettingKey,
  type ProtoSettings
} from '../../lib/decoders'
import { pickFile } from '../../lib/files'
import { useSetting } from '../../lib/hooks'
import { toast } from '../../state/toasts'

/**
 * Protobuf definitions for a connection (PBI-044). Register .proto files, then say which message
 * type each subject carries; matching payloads are shown decoded in every message viewer.
 */
export function DecodersTab({ connId }: { connId: string }): ReactNode {
  const [settings, setSettings, loaded] = useSetting<ProtoSettings>(
    protoSettingKey(connId),
    EMPTY_PROTO
  )
  const [error, setError] = useState<unknown>(null)
  const { registry } = useMemo(() => buildProtoDecoders(settings), [settings])

  const addFile = async (): Promise<void> => {
    const file = await pickFile('.proto,text/plain')
    if (!file) return
    setError(null)
    try {
      const source = await file.text()
      if (source.length > 2_000_000)
        throw new Error('This file is larger than 2 MB, which is not a normal .proto file')
      setSettings({
        ...settings,
        files: [...settings.files.filter((f) => f.name !== file.name), { name: file.name, source }]
      })
      toast.ok(`Added ${file.name}`)
    } catch (err) {
      setError(err)
    }
  }

  const setMapping = (index: number, patch: Partial<ProtoSettings['mappings'][number]>): void =>
    setSettings({
      ...settings,
      mappings: settings.mappings.map((m, i) => (i === index ? { ...m, ...patch } : m))
    })

  return (
    <Page
      title="Decoders"
      subtitle="Show Protobuf payloads as readable JSON"
      actions={
        <Button
          variant="primary"
          icon={<FileUp className="h-3.5 w-3.5" aria-hidden />}
          disabled={!loaded}
          onClick={() => void addFile()}
        >
          Add .proto file
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <ErrorNote error={error} />
        <Card title={`Protobuf files (${settings.files.length})`}>
          {settings.files.length === 0 ? (
            <p className="text-muted">
              Add the .proto files that define your messages. Files that import each other should
              all be added; the studio resolves types across them.
            </p>
          ) : (
            <ul className="flex flex-col">
              {settings.files.map((file) => {
                const problem = registry.errors.find((e) => e.file === file.name)
                return (
                  <li
                    key={file.name}
                    className="flex items-center gap-2 border-t border-line py-1.5 first:border-t-0"
                  >
                    <span className="font-mono text-xs">{file.name}</span>
                    <span className="text-xs text-faint">
                      {file.source.split('\n').length} lines
                    </span>
                    {problem && (
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-danger"
                        title={problem.message}
                      >
                        Cannot be parsed: {problem.message}
                      </span>
                    )}
                    <Button
                      className="ml-auto"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${file.name}`}
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                      onClick={() =>
                        setSettings({
                          ...settings,
                          files: settings.files.filter((f) => f.name !== file.name)
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}
          {registry.errors
            .filter((e) => !settings.files.some((f) => f.name === e.file))
            .map((e) => (
              <Notice key={e.message} tone="danger" className="mt-2">
                {e.message}
              </Notice>
            ))}
          {registry.types.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              {registry.types.length} message {registry.types.length === 1 ? 'type' : 'types'}:{' '}
              <span className="font-mono">{registry.types.slice(0, 12).join(', ')}</span>
              {registry.types.length > 12 ? ` and ${registry.types.length - 12} more` : ''}
            </p>
          )}
        </Card>

        <Card
          title={`Subject mappings (${settings.mappings.length})`}
          actions={
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden />}
              disabled={registry.types.length === 0}
              title={registry.types.length === 0 ? 'Add a .proto file first' : undefined}
              onClick={() =>
                setSettings({
                  ...settings,
                  mappings: [...settings.mappings, { pattern: '', type: registry.types[0] }]
                })
              }
            >
              Add mapping
            </Button>
          }
        >
          {settings.mappings.length === 0 ? (
            <p className="text-muted">
              A mapping says which message type is published on a subject, for example orders.&gt;
              carries shop.Order. The first mapping that matches a subject is used.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {settings.mappings.map((mapping, i) => {
                const subjectError = mapping.pattern ? validateSubject(mapping.pattern) : null
                const unknownType = mapping.type && !registry.types.includes(mapping.type)
                return (
                  <li key={i} className="flex flex-wrap items-start gap-2">
                    <div className="w-72">
                      <Input
                        mono
                        aria-label={`Mapping ${i + 1} subject`}
                        placeholder="orders.>"
                        invalid={!!subjectError}
                        value={mapping.pattern}
                        onChange={(e) => setMapping(i, { pattern: e.target.value })}
                      />
                      {subjectError && <p className="pt-0.5 text-xs text-danger">{subjectError}</p>}
                    </div>
                    <span className="pt-1.5 text-muted">carries</span>
                    <div className="w-72">
                      <Select
                        aria-label={`Mapping ${i + 1} message type`}
                        value={mapping.type}
                        onChange={(e) => setMapping(i, { type: e.target.value })}
                      >
                        {unknownType && (
                          <option value={mapping.type}>{mapping.type} (missing)</option>
                        )}
                        {registry.types.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </Select>
                      {unknownType && (
                        <p className="pt-0.5 text-xs text-danger">
                          This type is not in the files above.
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      aria-label={`Remove mapping ${i + 1}`}
                      icon={<Trash2 className="h-4 w-4" aria-hidden />}
                      onClick={() =>
                        setSettings({
                          ...settings,
                          mappings: settings.mappings.filter((_, j) => j !== i)
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Notice>
          When a payload cannot be decoded with its mapped type, the viewer says so and shows hex
          instead. JSON and text payloads need no decoder. Other formats such as Avro or MessagePack
          can be added in <span className="font-mono">src/renderer/src/lib/decoders.ts</span>.
        </Notice>
      </div>
    </Page>
  )
}
