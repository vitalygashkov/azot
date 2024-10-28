import { Component, JSX } from 'solid-js';
import { cn } from './cn';

interface CellProps {
  title?: string;
  subtitle?: string;
  children: JSX.Element;
  variant?: 'default' | 'primary' | 'danger';
  before?: JSX.Element;
  after?: JSX.Element;
  component?: 'div' | 'button' | 'label';
  onClick?: () => void;
}

export const Cell: Component<CellProps> = (props) => {
  const cellProps = mergeProps({ Component: 'div' }, props);

  const component = (props: any) => {
    switch (cellProps.component) {
      case 'button':
        return <button {...props} />;
      case 'label':
        return <label {...props} />;
      default:
      case 'div':
        return <div {...props} />;
    }
  };

  return (
    <Dynamic
      component={component}
      class={cn(
        'bg-white w-full min-h-9 py-2 rounded-lg text-[13px] flex items-center gap-3 px-3 cursor-pointer',
        'transition hover:bg-slate-50 active:bg-slate-100',
        props.variant === 'primary' && 'text-[#007AFF]',
        props.variant === 'danger' && 'text-[#E53935]',
      )}
      title={props.title}
      onClick={props.onClick}
    >
      {props.before && (
        <div class="[&>svg]:w-[18px] [&>svg]:h-[18px]">{props.before}</div>
      )}
      <div class="flex flex-col truncate">{props.children}</div>
      {props.after && <div class="ml-auto">{props.after}</div>}
    </Dynamic>
  );
};