import { EventEmitter } from 'events';

export type BoardEvent =
  | {
      type: 'ticket.created';
      projectId: string;
      ticketId: string;
      workflowStateId?: string | null;
      at: string;
    }
  | {
      type: 'ticket.updated';
      projectId: string;
      ticketId: string;
      workflowStateId?: string | null;
      at: string;
    }
  | {
      type: 'ticket.moved';
      projectId: string;
      ticketId: string;
      workflowStateId: string;
      at: string;
    }
  | {
      type: 'workflow.updated';
      projectId: string;
      at: string;
    };

const boardEventBus = new EventEmitter();
boardEventBus.setMaxListeners(100);

function projectChannel(projectId: string): string {
  return `project:${projectId}`;
}

export function emitBoardEvent(event: BoardEvent): void {
  boardEventBus.emit(projectChannel(event.projectId), event);
}

export function subscribeToBoardEvents(projectId: string, handler: (event: BoardEvent) => void): () => void {
  const channel = projectChannel(projectId);
  boardEventBus.on(channel, handler);
  return () => {
    boardEventBus.off(channel, handler);
  };
}
