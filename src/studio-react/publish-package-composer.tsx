import { Link } from 'react-router'
import { Badge, Button, Input, Textarea } from '@tangle-network/sandbox-ui/primitives'
import type { IntegrationConnection } from '@tangle-network/sandbox-ui/integrations'
import { AlertTriangle, CalendarClock, Check } from 'lucide-react'
import { CADENCES, DESTINATIONS, isDestinationConnected } from '../studio'
import { Field, NativeSelect } from './composer-shell'

export function PublishPackageComposer({
  caption,
  postDescription,
  mentions,
  cadence,
  selectedDestinations,
  connections,
  connectionError,
  connectionsLoading,
  integrationsHref,
  canManageIntegrations,
  onCaptionChange,
  onDescriptionChange,
  onMentionsChange,
  onCadenceChange,
  onDestinationToggle,
}: {
  caption: string
  postDescription: string
  mentions: string
  cadence: string
  selectedDestinations: string[]
  connections: IntegrationConnection[]
  connectionError: Error | null
  connectionsLoading: boolean
  integrationsHref?: string
  canManageIntegrations: boolean
  onCaptionChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onMentionsChange: (value: string) => void
  onCadenceChange: (value: string) => void
  onDestinationToggle: (destination: string) => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {connectionError ? (
          <div className="flex items-center gap-2 rounded-md border border-warning/20 bg-warning/5 px-2.5 py-1.5 text-xs text-warning">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Couldn't load connected apps. Check Integrations.
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {connectionsLoading
              ? 'Checking connected apps…'
              : 'Stage captions, destinations, cadence. Saved with the generated asset.'}
          </p>
        )}
        {integrationsHref && canManageIntegrations && (
          <Link to={integrationsHref} prefetch="intent" className="shrink-0">
            <Button variant="outline" size="sm">Connect</Button>
          </Link>
        )}
      </div>
      <div className="grid gap-2">
        {DESTINATIONS.map((destination) => {
          const connected = isDestinationConnected(destination, connections)
          const active = connected && selectedDestinations.includes(destination.id)
          return (
            <button
              key={destination.id}
              type="button"
              disabled={!connected}
              aria-pressed={active}
              onClick={() => onDestinationToggle(destination.id)}
              className={`rounded-md border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                active
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  {destination.label}
                </span>
                <Badge variant={active || connected ? 'default' : 'outline'}>{active ? 'Selected' : connected ? 'Ready' : 'Not connected'}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{destination.fields}</p>
            </button>
          )
        })}
      </div>
      <Field label="Caption" className="space-y-2">
        <Textarea value={caption} onChange={(event) => onCaptionChange(event.target.value)} rows={3} placeholder="Write or generate the caption for selected destinations..." />
      </Field>
      <Field label="Description / CTA" className="space-y-2">
        <Textarea value={postDescription} onChange={(event) => onDescriptionChange(event.target.value)} rows={2} placeholder="Release note, product context, link, or approval instruction..." />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mentions" className="space-y-2">
          <Input value={mentions} onChange={(event) => onMentionsChange(event.target.value)} placeholder="@creator, @partner" />
        </Field>
        <Field label="Cadence" className="space-y-2">
          <NativeSelect value={cadence} onChange={(event) => onCadenceChange(event.target.value)}>
            {CADENCES.map((option) => <option key={option} value={option}>{option}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex items-center gap-2 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
        <CalendarClock className="h-3.5 w-3.5" />
        Publish packages stay attached to generated media and can run through connected GTM apps.
      </div>
    </div>
  )
}
