-- #77: өмнө нь «Өгсөн» болсон падааны бараа аль хэдийн жолоочид шилжсэн (хуучин дүрэм) — «Хүлээн авсан» болгоно.
-- Бараа дахин хөдлөхгүй (журналд өөрчлөлтгүй).
UPDATE "Handover" SET status = 'RECEIVED', "receivedAt" = "handedOverAt", "receivedBy" = 'Автомат (шинэчлэлийн өмнө өгсөн)'
WHERE status = 'HANDED_OVER';
UPDATE "HandoverCheck" c SET "driverCheckedAt" = h."handedOverAt" FROM "Handover" h WHERE h.id = c."handoverId" AND h.status = 'RECEIVED' AND c."driverCheckedAt" IS NULL;
