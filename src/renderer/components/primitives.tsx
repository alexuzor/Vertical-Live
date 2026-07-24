/** Small shared building blocks used across the panels. */

import type { ReactNode } from 'react';
import { useId } from 'react';

import { Dropdown } from './Dropdown';

/* ---- Panel ---- */

export function Panel({
  title,
  num,
  aside,
  labelledBy,
  children,
}: {
  title: string;
  num?: string;
  aside?: ReactNode;
  labelledBy?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="panel panel__pad" aria-labelledby={labelledBy ?? headingId}>
      <div className="panel__head">
        <h2 className="panel__title" id={labelledBy ?? headingId}>
          {num ? <span className="num">{num}</span> : null}
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ---- Field wrapper ---- */

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

/* ---- SelectField ---- */

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  id,
  value,
  options,
  onChange,
  icon,
  ariaLabel,
  disabled,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Dropdown
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      icon={icon}
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  );
}
