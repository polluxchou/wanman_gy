import { useState } from 'react';
import { useSendMessage } from '../hooks/useWanman.js';
import type { SendMessageInput } from '@wanman/cockpit-client';

interface SendMessageModalProps {
  /** Pre-filled recipient agent name. */
  to?: string;
  /** Pre-filled message type. */
  type?: SendMessageInput['type'];
  /** Related task id (embedded in payload). */
  relatedTaskId?: string;
  /** Related thread id. */
  relatedThreadId?: string;
  /** Title shown in the modal header. */
  title?: string;
  onClose: () => void;
  /** List of available agents for the "to" dropdown when `to` is not pre-filled. */
  agents?: string[];
}

export function SendMessageModal({
  to: initialTo,
  type: initialType = 'message',
  relatedTaskId,
  relatedThreadId,
  title = 'Send Message',
  onClose,
  agents = [],
}: SendMessageModalProps) {
  const [to, setTo] = useState(initialTo ?? '');
  const [type, setType] = useState<SendMessageInput['type']>(initialType);
  const [payload, setPayload] = useState('');
  const [priority, setPriority] = useState<'normal' | 'steer'>('normal');
  const { mutate: send, isPending, error } = useSendMessage();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!to.trim() || !payload.trim()) return;
    send(
      { to: to.trim(), type, payload: payload.trim(), priority, relatedTaskId, relatedThreadId },
      { onSuccess: onClose },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200">
          <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-lg leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* To */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">To</label>
            {initialTo ? (
              <div className="px-3 py-2 text-sm font-medium bg-stone-100 rounded text-stone-800">{initialTo}</div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  placeholder="agent name"
                  className="flex-1 text-sm px-3 py-2 border border-stone-300 rounded focus:outline-none focus:ring-2 focus:ring-orange-300"
                  list="agent-datalist"
                />
                <datalist id="agent-datalist">
                  {agents.map(a => <option key={a} value={a} />)}
                </datalist>
              </div>
            )}
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">Type</label>
            <select
              value={type}
              onChange={e => setType(e.target.value as SendMessageInput['type'])}
              className="w-full text-sm px-3 py-2 border border-stone-300 rounded focus:outline-none focus:ring-2 focus:ring-orange-300"
            >
              <option value="message">message — general message</option>
              <option value="decision_response">decision_response — reply to a decision request</option>
              <option value="blocker_response">blocker_response — reply to a blocker</option>
            </select>
          </div>

          {/* Priority */}
          <div className="flex items-center gap-4">
            <label className="text-xs font-medium text-stone-600">Priority</label>
            <label className="flex items-center gap-1.5 text-sm text-stone-700 cursor-pointer">
              <input type="radio" name="priority" value="normal" checked={priority === 'normal'} onChange={() => setPriority('normal')} />
              Normal
            </label>
            <label className="flex items-center gap-1.5 text-sm text-stone-700 cursor-pointer">
              <input type="radio" name="priority" value="steer" checked={priority === 'steer'} onChange={() => setPriority('steer')} />
              <span className="font-medium text-amber-700">Steer</span>
              <span className="text-xs text-stone-400">(interrupts current run)</span>
            </label>
          </div>

          {/* Message */}
          <div>
            <label className="block text-xs font-medium text-stone-600 mb-1">Message</label>
            <textarea
              value={payload}
              onChange={e => setPayload(e.target.value)}
              placeholder="Your message to the agent…"
              rows={4}
              className="w-full text-sm px-3 py-2 border border-stone-300 rounded resize-none focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          {relatedTaskId && (
            <p className="text-xs text-stone-400">
              Linked to task <span className="font-mono">{relatedTaskId.slice(0, 8)}</span>
            </p>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error instanceof Error ? error.message : 'Send failed'}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-stone-600 hover:text-stone-900 rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || !to.trim() || !payload.trim()}
              className="px-4 py-2 text-sm font-medium bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
            >
              {isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
