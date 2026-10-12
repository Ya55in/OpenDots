import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyButton({
  text,
  label = 'Copy message',
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className="message-copy"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus('copied');
        } catch {
          setStatus('failed');
        }
      }}
    >
      {status === 'copied' ? <Check size={14} /> : <Copy size={14} />}
      <span role="status">
        {status === 'copied'
          ? 'Copied'
          : status === 'failed'
            ? 'Copy failed · retry'
            : 'Copy'}
      </span>
    </button>
  );
}
