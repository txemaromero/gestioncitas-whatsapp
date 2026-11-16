/**
 * CU-C6 Elegir profesional. 1-2 professionals → reply buttons (+ "Cancelar");
 * 3 or more → list message (WhatsApp allows only 3 buttons). Typed names are accepted too.
 */
import { getArray, getString, text, type FlowContext, type FlowResult } from '../engine/flow';
import { matchEmployee } from '../engine/matching';
import { T } from '../engine/texts';
import type { IncomingMessage, OutgoingMessage } from '../engine/types';
import { confirmationFlow } from './confirmationFlow';

export const EMPLOYEE_PREFIX = 'EMP:';
export const CANCEL_ID = 'CANCEL';

interface Option {
  id: string;
  name: string;
  role: string;
}

function selectionMessage(clinic: string, options: Option[]): OutgoingMessage {
  const body = T.chooseEmployee(clinic);
  if (options.length <= 2) {
    return {
      type: 'buttons',
      body,
      buttons: [
        ...options.map((o) => ({ id: `${EMPLOYEE_PREFIX}${o.id}`, title: o.name })),
        { id: CANCEL_ID, title: T.cancel },
      ],
    };
  }
  return {
    type: 'list',
    body,
    buttonText: T.listButton,
    sections: [
      {
        title: 'Profesionales',
        rows: [
          ...options.slice(0, 9).map((o) => ({ id: `${EMPLOYEE_PREFIX}${o.id}`, title: o.name, description: o.role })),
          { id: CANCEL_ID, title: T.cancel },
        ],
      },
    ],
  };
}

export const employeeFlow = {
  name: 'employee' as const,

  start(ctx: FlowContext, start: Date, employees: readonly Option[]): FlowResult {
    const options = employees.map((e) => ({ id: e.id, name: e.name, role: e.role }));
    return {
      replies: [selectionMessage(ctx.tenant.clinicName, options)],
      next: { flow: 'employee', step: 'select', data: { start: start.toISOString(), options } },
    };
  },

  async handle(ctx: FlowContext, message: IncomingMessage): Promise<FlowResult> {
    const data = ctx.state?.data;
    const startIso = getString(data, 'start');
    const options = getArray<Option>(data, 'options');
    if (!startIso || options.length === 0) {
      return { replies: [text(T.askDate(ctx.tenant.clinicName))], next: { flow: 'cita', step: 'askDate' } };
    }
    const byPayload = message.payloadId?.startsWith(EMPLOYEE_PREFIX)
      ? options.find((o) => o.id === message.payloadId?.slice(EMPLOYEE_PREFIX.length))
      : undefined;
    const chosen = byPayload ?? matchEmployee(message.text, options);
    if (!chosen) {
      return {
        replies: [text(T.employeeNotFound), selectionMessage(ctx.tenant.clinicName, options)],
        next: { flow: 'employee', step: 'select', data: data ?? {} },
        error: true,
      };
    }
    return confirmationFlow.start(ctx, new Date(startIso), chosen);
  },
};
