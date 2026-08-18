// Per-person Turbo IQ headshot deliveries: every registered/checked-in subject
// gets their own prefix-matched delivery (their uploads group to it
// automatically server-side) and a personal /headshot/{token} page.
class Deliveries {
  /** @param {object} deps { settings, shoots, gallery, push } */
  constructor(deps) {
    this.d = deps;
    this.inflight = new Map(); // personId -> Promise (single-flight)
  }

  /**
   * Idempotent, fail-soft. Stores person.iq = {deliveryId, accessToken,
   * headshotUrl} on success. Safe to call from concurrent sites.
   */
  ensureForPerson(personId, { checkinEntryId } = {}) {
    if (this.inflight.has(personId)) return this.inflight.get(personId);
    const p = this._ensure(personId, checkinEntryId).finally(() => this.inflight.delete(personId));
    this.inflight.set(personId, p);
    return p;
  }

  async _ensure(personId, checkinEntryId) {
    const person = this.d.shoots.getPerson(personId);
    if (!person) return null;
    if (person.iq?.deliveryId) return person.iq;
    const shoot = this.d.shoots.getShoot(person.shootId);
    if (!shoot?.galleryId) return null; // no gallery — nothing to deliver into
    const client = await this.d.gallery.ensureAuthed().catch(() => null);
    if (!client) return null;

    const res = await client.ensureHeadshotDelivery(shoot.galleryId, {
      referenceNumber: `${person.shootNumber}_`,
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      mobile: person.mobile,
      company: person.company,
      checkinEntryId: checkinEntryId ?? person.checkinEntryId ?? null,
    });
    if (!res.success) {
      this.d.push('processing-log', { message: `IQ delivery setup failed for ${person.firstName}: ${res.error}`, type: 'warning' });
      return null;
    }
    if (res.conflict) {
      this.d.push('processing-log', {
        message: `IQ delivery ref ${person.shootNumber}_ already belongs to "${res.delivery?.name}" — resolve in the gallery's Headshots panel`,
        type: 'warning',
      });
      return null;
    }
    const iq = {
      deliveryId: res.delivery.id,
      accessToken: res.delivery.access_token,
      headshotUrl: res.headshotUrl,
    };
    this.d.shoots.updatePerson(personId, (x) => { x.iq = iq; });
    this.d.push('people:changed', {});
    return iq;
  }
}

module.exports = { Deliveries };
