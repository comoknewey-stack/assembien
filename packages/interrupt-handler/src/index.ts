import type {
  TaskInterruptClassification,
  TaskInterruptHandler,
  TaskInterruptRequest
} from '@assem/shared-types';

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[`"'’]/g, '')
    .replace(/[?!,.;:¡¿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTrimmedGroup(
  match: RegExpExecArray | null,
  index: number
): string | null {
  const value = match?.[index]?.trim();
  return value ? value : null;
}

function createClarification(
  matchedText: string,
  clarificationMessage: string,
  reason: string
): TaskInterruptClassification {
  return {
    kind: 'task_clarification_needed',
    matchedText,
    clarificationMessage,
    reason
  };
}

export class DeterministicTaskInterruptHandler implements TaskInterruptHandler {
  classify(request: TaskInterruptRequest): TaskInterruptClassification {
    const normalized = normalizeIntentText(request.text);

    const status = this.classifyStatusQuery(normalized);
    if (status) {
      return {
        kind: 'task_status_query',
        matchedText: normalized,
        statusQueryKind: status
      };
    }

    if (this.isPause(normalized)) {
      return {
        kind: 'task_pause',
        matchedText: normalized
      };
    }

    if (this.isResume(normalized)) {
      return {
        kind: 'task_resume',
        matchedText: normalized
      };
    }

    if (this.isCancel(normalized)) {
      return {
        kind: 'task_cancel',
        matchedText: normalized
      };
    }

    const outputRefinement = this.classifyOutputRefinement(normalized);
    if (outputRefinement) {
      return {
        kind: 'task_output_refinement',
        matchedText: normalized,
        refinement: outputRefinement
      };
    }

    const goalRefinement = this.classifyGoalRefinement(normalized);
    if (goalRefinement) {
      return goalRefinement;
    }

    return {
      kind: 'independent_query',
      matchedText: normalized
    };
  }

  private classifyStatusQuery(
    normalized: string
  ): TaskInterruptClassification['statusQueryKind'] | null {
    if (
      /^(?:que estas haciendo|que estas haciendo ahora|en que estas|what are you doing|what are you doing now)$/.test(
        normalized
      )
    ) {
      return 'status';
    }

    if (
      /^(?:cuanto te queda|cuanto queda|cuanto falta|que te falta|how much is left|whats left|what is left)$/.test(
        normalized
      )
    ) {
      return 'remaining';
    }

    if (/^(?:progreso|progress)$/.test(normalized)) {
      return 'progress';
    }

    if (
      /^(?:en que vas|en que paso vas|que paso llevas|what step are you on|what step are you at)$/.test(
        normalized
      )
    ) {
      return 'step';
    }

    if (
      /^(?:ya terminaste|ya has terminado|has terminado|are you done|did you finish)$/.test(
        normalized
      )
    ) {
      return 'completion';
    }

    if (
      /^(?:cual es el plan|cual es tu plan|que plan vas a seguir|que pasos vas a seguir|what is the plan|what steps will you follow)$/.test(
        normalized
      )
    ) {
      return 'plan';
    }

    return null;
  }

  private isPause(normalized: string): boolean {
    return /^(?:pausa|para|para ya|detenlo|detente|pause|stop)$/.test(normalized);
  }

  private isResume(normalized: string): boolean {
    return /^(?:reanuda|sigue|continua|continua ya|resume|continue)$/.test(
      normalized
    );
  }

  private isCancel(normalized: string): boolean {
    return /^(?:cancela|cancela la tarea|aborta|cancel|abort)$/.test(normalized);
  }

  private classifyOutputRefinement(
    normalized: string
  ): TaskInterruptClassification['refinement'] | null {
    if (
      /^(?:hazlo mas corto|hazlo mas breve|hazlo breve|make it shorter|make it brief)$/.test(
        normalized
      )
    ) {
      return {
        category: 'output',
        type: 'length',
        instruction: normalized,
        label: 'Salida mas corta',
        value: 'shorter'
      };
    }

    if (
      /^(?:hazlo en ingles|ponlo en ingles|en ingles|make it in english|do it in english)$/.test(
        normalized
      )
    ) {
      return {
        category: 'output',
        type: 'language',
        instruction: normalized,
        label: 'Salida en ingles',
        value: 'en'
      };
    }

    if (
      /^(?:hazlo en espanol|hazlo en castellano|ponlo en espanol|ponlo en castellano|make it in spanish|do it in spanish)$/.test(
        normalized
      )
    ) {
      return {
        category: 'output',
        type: 'language',
        instruction: normalized,
        label: 'Salida en espanol',
        value: 'es'
      };
    }

    if (
      /^(?:primero dame un resumen|dame primero un resumen|give me a summary first)$/.test(
        normalized
      )
    ) {
      return {
        category: 'output',
        type: 'summary_priority',
        instruction: normalized,
        label: 'Priorizar resumen',
        value: 'first'
      };
    }

    if (
      /^(?:anade una tabla|incluye una tabla|mete una tabla|add a table|include a table)$/.test(
        normalized
      )
    ) {
      return {
        category: 'output',
        type: 'format',
        instruction: normalized,
        label: 'Anadir tabla',
        value: 'table'
      };
    }

    return null;
  }

  private classifyGoalRefinement(
    normalized: string
  ): TaskInterruptClassification | null {
    if (
      /^(?:eso no era lo que queria|eso no es lo que queria|me referia a otra cosa)$/.test(
        normalized
      )
    ) {
      return createClarification(
        normalized,
        'Necesito que me digas brevemente que cambio quieres en la tarea activa. Por ejemplo: "cambia el enfoque a riesgos" o "hazlo sobre costes".',
        'La correccion no especifica todavia el nuevo objetivo.'
      );
    }

    if (/^(?:cambia el enfoque|change the focus)$/.test(normalized)) {
      return createClarification(
        normalized,
        'Dime hacia que enfoque quieres mover la tarea activa. Por ejemplo: "cambia el enfoque a riesgos y costes".',
        'El cambio de enfoque no trae el nuevo objetivo.'
      );
    }

    const focusMatch =
      /^(?:cambia el enfoque(?:\s+(?:a|hacia))?|enfocalo(?:\s+en)?|hazlo sobre|make it about)\s+(.+)$/.exec(
        normalized
      ) ??
      /^(?:me referia a)\s+(.+)$/.exec(normalized);
    const focusTarget = extractTrimmedGroup(focusMatch, 1);

    if (focusTarget && !/^(?:otra cosa|algo mas|something else)$/.test(focusTarget)) {
      return {
        kind: 'task_goal_refinement',
        matchedText: normalized,
        refinement: {
          category: 'goal',
          type: 'focus',
          instruction: normalized,
          label: `Cambiar enfoque a ${focusTarget}`,
          value: focusTarget
        }
      };
    }

    return null;
  }
}
