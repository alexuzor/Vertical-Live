/**
 * A modern, fully custom dropdown (native <option> menus can't be themed).
 *
 * The menu renders in a portal so it never clips against the scrolling control
 * column, positions itself under (or above) the trigger, and is keyboard
 * accessible: Up/Down/Home/End to move, Enter/Space to choose, Escape to close.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { IconCheck, IconChevronDown } from './icons';

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps {
  id?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}

interface MenuPos {
  left: number;
  top: number;
  width: number;
  placement: 'below' | 'above';
}

export function Dropdown({ id, value, options, onChange, icon, ariaLabel, disabled }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const selected = options[selectedIndex];

  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuHeight = Math.min(options.length * 36 + 10, 280);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceBelow < menuHeight + 12 && rect.top > menuHeight ? 'above' : 'below';
    setPos({
      left: rect.left,
      top: placement === 'below' ? rect.bottom + 6 : rect.top - menuHeight - 6,
      width: rect.width,
      placement,
    });
  }, [options.length]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    computePos();
    setActiveIndex(selectedIndex);
    setOpen(true);
  }, [computePos, disabled, selectedIndex]);

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) onChange(option.value);
      close();
    },
    [close, onChange, options],
  );

  // Reposition while open; close on outside interaction.
  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onScroll = (): void => setOpen(false);
    const onResize = (): void => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const t = event.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const onTriggerKey = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKey = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % options.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + options.length) % options.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        choose(activeIndex);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`dd${icon ? ' dd--icon' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {icon ? <span className="dd__icon">{icon}</span> : null}
        <span className="dd__value">{selected?.label ?? ''}</span>
        <span className={`dd__chev${open ? ' is-open' : ''}`}>
          <IconChevronDown size={16} />
        </span>
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className={`dd-menu dd-menu--${pos.placement}`}
              role="listbox"
              id={listId}
              aria-label={ariaLabel}
              tabIndex={-1}
              style={{ left: pos.left, top: pos.top, width: pos.width }}
              onKeyDown={onMenuKey}
            >
              {options.map((option, index) => (
                <div
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  className={`dd-option${index === activeIndex ? ' is-active' : ''}${
                    option.value === value ? ' is-selected' : ''
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span className="dd-option__label">{option.label}</span>
                  {option.value === value ? (
                    <span className="dd-option__check">
                      <IconCheck size={15} />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
