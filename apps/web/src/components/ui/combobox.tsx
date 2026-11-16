'use client';

import { Command } from 'cmdk';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string | null;
}

/** Searchable select (cmdk + popover), e.g. the client picker of the appointment form. */
export function Combobox({
  id,
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder = 'Buscar…',
  emptyText = 'Sin resultados',
  invalid,
}: {
  id?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((o) => o.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={invalid || undefined}
          className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>{selected?.label ?? placeholder}</span>
          <ChevronsUpDownIcon className="size-4 opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) rounded-md border bg-popover p-0 text-popover-foreground shadow-md"
        >
          <Command
            filter={(itemValue, search) =>
              itemValue
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .toLowerCase()
                .includes(search.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())
                ? 1
                : 0
            }
          >
            <Command.Input
              placeholder={searchPlaceholder}
              className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
            />
            <Command.List id={listId} className="max-h-64 overflow-y-auto p-1">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">{emptyText}</Command.Empty>
              {options.map((option) => (
                <Command.Item
                  key={option.value}
                  value={`${option.label} ${option.description ?? ''} ${option.value}`}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <CheckIcon className={cn('size-4', option.value === value ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{option.label}</span>
                  {option.description ? <span className="ml-auto text-xs text-muted-foreground">{option.description}</span> : null}
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
