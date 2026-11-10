/** Сервер эхлэхэд арын ажлыг (Meta илгээх, хугацаа дууссан захиалга цуцлах) асаана */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startJobs } = await import('./lib/jobs');
    startJobs();
  }
}
