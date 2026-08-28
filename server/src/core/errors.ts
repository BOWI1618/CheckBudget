/**
 * Типизированные доменные ошибки. Транспорт (Fastify) знает, как превратить
 * каждую в HTTP-ответ вида { error: { code, message, ... } }.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Требуется вход') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Недостаточно прав') =>
  new AppError(403, 'forbidden', message);

/**
 * 404 используется и для «не существует», и для «нет доступа».
 * Это намеренно: иначе перебором budget_id можно было бы узнать,
 * какие бюджеты существуют в системе.
 */
export const notFound = (message = 'Не найдено') =>
  new AppError(404, 'not_found', message);

export const preconditionRequired = (message = 'Требуется версия объекта') =>
  new AppError(428, 'precondition_required', message);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** 409 всегда несёт актуальное состояние объекта — клиенту нужно его показать. */
export class VersionConflictError extends AppError {
  constructor(readonly current: unknown) {
    super(409, 'version_conflict', 'Объект изменён другим участником');
    this.name = 'VersionConflictError';
  }
}
