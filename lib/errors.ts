/** Хэрэглэгчид харуулах алдаа (монголоор) + HTTP код */
export class AppError extends Error {
  constructor(public status: number, message: string, public code: string = 'error') {
    super(message);
  }
}

export const unauthorized = () => new AppError(401, 'Нэвтрэх шаардлагатай', 'unauthorized');
export const forbidden = (msg = 'Танд энэ үйлдлийг хийх эрх байхгүй') => new AppError(403, msg, 'forbidden');
export const notFound = (msg = 'Олдсонгүй') => new AppError(404, msg, 'not_found');
export const badRequest = (msg: string, code = 'bad_request') => new AppError(400, msg, code);
export const conflict = (msg: string, code = 'conflict') => new AppError(409, msg, code);
