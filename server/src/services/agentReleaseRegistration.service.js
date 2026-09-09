async function persistReleaseRecord(db, data) {
  return db.$transaction(async (tx) => {
    const registered = await tx.agentRelease.upsert({
      where: { version: data.version },
      create: data.create,
      update: data.update
    });
    if (data.activate) {
      await tx.agentRelease.updateMany({
        where: { active: true, NOT: { id: registered.id } },
        data: { active: false }
      });
    }
    return registered;
  });
}

module.exports = { persistReleaseRecord };
