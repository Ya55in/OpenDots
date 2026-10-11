import {
  Component,
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  Renderer,
  createLibrary,
  defineComponent,
  useTriggerAction,
} from '@openuidev/react-lang';
import { z } from 'zod';
import {
  openUIActionDraft,
  openUIProps,
  validateOpenUI,
} from '../shared/openui';
import './openui.css';

const FormContext = createContext({
  values: {} as Record<string, string>,
  set: (_name: string, _value: string) => {},
});
const Text = defineComponent({
  name: 'Text',
  description: 'Plain text',
  props: openUIProps.Text,
  component: ({ props }) => <p>{props.text}</p>,
});
const Metric = defineComponent({
  name: 'Metric',
  description: 'A labeled value',
  props: openUIProps.Metric,
  component: ({ props }) => (
    <div className="openui-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  ),
});
const Table = defineComponent({
  name: 'Table',
  description: 'A comparison table',
  props: openUIProps.Table,
  component: ({ props }) => (
    <div className="openui-table">
      <table>
        <thead>
          <tr>
            {props.columns.map((column, i) => (
              <th key={i} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
});
const BarChart = defineComponent({
  name: 'BarChart',
  description: 'Nonnegative values',
  props: openUIProps.BarChart,
  component: ({ props }) => (
    <div className="openui-bars">
      {props.labels.map((label, i) => (
        <div key={i}>
          <span>
            {label}: <strong>{props.values[i]}</strong>
          </span>
          <div
            aria-hidden="true"
            style={{
              width: `${(100 * props.values[i]) / Math.max(1, ...props.values)}%`,
            }}
          />
        </div>
      ))}
    </div>
  ),
});
const Choice = defineComponent({
  name: 'Choice',
  description: 'Prepare a user message',
  props: openUIProps.Choice,
  component: function Choice({ props }) {
    const trigger = useTriggerAction();
    return (
      <button type="button" onClick={() => trigger(props.label)}>
        {props.label}
      </button>
    );
  },
});
const Input = defineComponent({
  name: 'Input',
  description: 'Text field',
  props: openUIProps.Input,
  component: function Input({ props }) {
    const form = useContext(FormContext);
    return (
      <label>
        {props.label}
        <input
          maxLength={1000}
          value={form.values[props.name] ?? props.value}
          onChange={(event) => form.set(props.name, event.target.value)}
        />
      </label>
    );
  },
});
const Select = defineComponent({
  name: 'Select',
  description: 'Selection field',
  props: openUIProps.Select,
  component: function Select({ props }) {
    const form = useContext(FormContext);
    return (
      <label>
        {props.label}
        <select
          value={form.values[props.name] ?? props.options[0]}
          onChange={(event) => form.set(props.name, event.target.value)}
        >
          {props.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  },
});
const Panel = defineComponent({
  name: 'Panel',
  description: 'Structured response',
  props: z.object({
    title: z.string(),
    children: z.array(
      z.union([
        Text.ref,
        Metric.ref,
        Table.ref,
        BarChart.ref,
        Choice.ref,
        Input.ref,
        Select.ref,
      ]),
    ),
  }),
  component: ({ props, renderNode }) => (
    <section>
      <h3>{props.title}</h3>
      {renderNode(props.children)}
    </section>
  ),
});
export const openUILibrary = createLibrary({
  components: [Panel, Text, Metric, Table, BarChart, Choice, Input, Select],
  root: 'Panel',
});

class Boundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function OpenUIBlock({
  source,
  disabled,
  onDraft,
}: {
  source: string;
  disabled: boolean;
  onDraft?: (draft: string) => void;
}) {
  const surface = useMemo(() => {
    try {
      return validateOpenUI(source);
    } catch {
      return null;
    }
  }, [source]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const fallback = (
    <div className="openui-fallback">
      <p>Interactive view unavailable. Original response:</p>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
  if (!surface || failed) return fallback;
  return (
    <Boundary key={source} fallback={fallback}>
      <div className="openui-surface">
        <fieldset disabled={disabled || !onDraft}>
          <FormContext.Provider
            value={{
              values,
              set: (name, value) =>
                setValues((current) => ({ ...current, [name]: value })),
            }}
          >
            <Renderer
              response={surface.source}
              library={openUILibrary}
              isStreaming={false}
              publishObservability={false}
              toolProvider={null}
              onError={(errors) => {
                if (errors.length) setFailed(true);
              }}
              onAction={(event) => {
                if (disabled || !onDraft) return;
                try {
                  onDraft(openUIActionDraft(surface, event, values));
                  setNotice(
                    'Prepared below. Review the message and press Send.',
                  );
                } catch {
                  setNotice('This action is unavailable.');
                }
              }}
            />
          </FormContext.Provider>
        </fieldset>
        <small>
          Choices prepare a message for review. Your Dot’s permissions still
          apply.
        </small>
        {notice && <p role="status">{notice}</p>}
        <details>
          <summary>View source</summary>
          <pre>
            <code>{source}</code>
          </pre>
        </details>
      </div>
    </Boundary>
  );
}
