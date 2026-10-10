import { useState } from 'react';
import { api } from './api';
type Result = {
  model: string;
  results: {
    item: string;
    category: string;
    confidence: number;
    needsReview: boolean;
  }[];
  note: string;
};
export function JevDecisions({
  threadId,
  disabled,
}: {
  threadId: string;
  disabled: boolean;
}) {
  const [items, setItems] = useState(''),
    [categories, setCategories] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Result>();
  return (
    <details>
      <summary>Classify directly with Jev</summary>
      <p>
        Sort short items into your categories. Uses Jev directly, without a
        generative model. Results are suggestions.
      </p>
      <label>
        Items, one per line
        <textarea
          aria-label="Jev items"
          value={items}
          onChange={(e) => setItems(e.target.value)}
          maxLength={20000}
        />
      </label>
      <label>
        Categories, one per line
        <textarea
          aria-label="Jev categories"
          value={categories}
          onChange={(e) => setCategories(e.target.value)}
          maxLength={500}
        />
      </label>
      <button
        type="button"
        disabled={disabled || busy || !items.trim() || !categories.trim()}
        onClick={async () => {
          setBusy(true);
          setError('');
          setResult(undefined);
          try {
            setResult(
              await api<Result>(
                `/conversations/${threadId}/decisions`,
                'POST',
                {
                  items: items
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  categories: categories
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                },
              ),
            );
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Classification failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Classifying…' : 'Classify with Jev'}
      </button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <p>{result.note}</p>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i}>
                  <td>{r.item}</td>
                  <td>{r.category}</td>
                  <td>
                    {Math.round(r.confidence * 100)}%
                    {r.needsReview ? ' · Review needed' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
}
