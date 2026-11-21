import { Request, Response } from 'express';
import { prisma } from '../../prisma';
import { normalizePhoneNumber } from '../../utils/phone';
import { logger } from '../../utils/logger';
import { sanitizeDisplayName } from '../../utils/text';
import { limits } from '../../config';

export class ContactsController {
  /**
   * GET /contacts
   * Returns contacts owned by the authenticated user
   */
  async getContacts(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const contacts = await prisma.emergencyContact.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });

      return res.status(200).json(contacts);
    } catch (error: any) {
      logger.error('Error in getContacts', { error: error.message });
      return res.status(500).json({ error: 'Failed to retrieve contacts' });
    }
  }

  /**
   * POST /contacts
   * Creates an emergency contact for the authenticated user
   */
  async createContact(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { name, phoneNumber, relationship, tier } = req.body;

      const cleanName = sanitizeDisplayName(name, 60);
      if (!cleanName) {
        return res.status(400).json({ error: 'Contact name is required (links are not allowed in names)' });
      }

      if (!phoneNumber) {
        return res.status(400).json({ error: 'Contact phone number is required' });
      }

      let normalizedPhone: string;
      try {
        normalizedPhone = normalizePhoneNumber(phoneNumber);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }

      // Check if user is adding their own phone number as an emergency contact
      if (normalizedPhone === req.user!.phoneNumber) {
        return res.status(400).json({ error: 'You cannot add your own phone number as an emergency contact' });
      }

      // Each SOS texts every contact, so cap the list (cost and abuse control)
      const contactCount = await prisma.emergencyContact.count({ where: { userId } });
      if (contactCount >= limits.maxContactsPerUser) {
        return res.status(400).json({
          error: `You can have at most ${limits.maxContactsPerUser} emergency contacts`,
          code: 'CONTACT_LIMIT',
        });
      }

      // Check duplicate per user
      const existing = await prisma.emergencyContact.findUnique({
        where: {
          userId_phoneNumber: {
            userId,
            phoneNumber: normalizedPhone,
          },
        },
      });

      if (existing) {
        return res.status(409).json({ error: 'An emergency contact with this phone number already exists' });
      }

      const contact = await prisma.emergencyContact.create({
        data: {
          userId,
          name: cleanName,
          phoneNumber: normalizedPhone,
          relationship: sanitizeDisplayName(relationship, 40) || null,
          consentStatus: 'PENDING',
          tier: tier === 'CRITICAL' ? 'CRITICAL' : 'EVERYDAY',
        },
      });

      logger.info('Emergency contact created', { userId, contactId: contact.id });
      return res.status(201).json(contact);
    } catch (error: any) {
      // Two concurrent creates of the same number: the unique index wins, report it as a duplicate.
      if (error?.code === 'P2002') {
        return res.status(409).json({ error: 'An emergency contact with this phone number already exists' });
      }
      logger.error('Error in createContact', { error: error.message });
      return res.status(500).json({ error: 'Failed to create contact' });
    }
  }

  /**
   * PATCH /contacts/:id
   * Updates a contact scoped strictly to the authenticated user
   */
  async updateContact(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const { name, phoneNumber, relationship, tier } = req.body;

      const existing = await prisma.emergencyContact.findFirst({
        where: { id, userId },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Contact not found' });
      }

      let normalizedPhone = existing.phoneNumber;
      if (phoneNumber && phoneNumber !== existing.phoneNumber) {
        try {
          normalizedPhone = normalizePhoneNumber(phoneNumber);
        } catch (err: any) {
          return res.status(400).json({ error: err.message });
        }

        if (normalizedPhone === req.user!.phoneNumber) {
          return res.status(400).json({ error: 'You cannot add your own phone number as an emergency contact' });
        }

        const duplicate = await prisma.emergencyContact.findUnique({
          where: {
            userId_phoneNumber: {
              userId,
              phoneNumber: normalizedPhone,
            },
          },
        });

        if (duplicate && duplicate.id !== id) {
          return res.status(409).json({ error: 'Another contact with this phone number already exists' });
        }
      }

      const cleanName = name !== undefined ? sanitizeDisplayName(name, 60) : undefined;
      if (name !== undefined && !cleanName) {
        return res.status(400).json({ error: 'Contact name cannot be empty (links are not allowed in names)' });
      }

      // Ownership is part of the write itself, not only the earlier lookup.
      const { count } = await prisma.emergencyContact.updateMany({
        where: { id, userId },
        data: {
          ...(cleanName ? { name: cleanName } : {}),
          ...(phoneNumber ? { phoneNumber: normalizedPhone } : {}),
          ...(relationship !== undefined ? { relationship: sanitizeDisplayName(relationship, 40) || null } : {}),
          ...(tier !== undefined ? { tier: tier === 'CRITICAL' ? 'CRITICAL' : 'EVERYDAY' } : {}),
        },
      });
      if (count === 0) return res.status(404).json({ error: 'Contact not found' });

      const updated = await prisma.emergencyContact.findFirst({ where: { id, userId } });
      return res.status(200).json(updated);
    } catch (error: any) {
      if (error?.code === 'P2002') {
        return res.status(409).json({ error: 'Another contact with this phone number already exists' });
      }
      logger.error('Error in updateContact', { error: error.message });
      return res.status(500).json({ error: 'Failed to update contact' });
    }
  }

  /**
   * DELETE /contacts/:id
   * Deletes a contact scoped strictly to the authenticated user
   */
  async deleteContact(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      const existing = await prisma.emergencyContact.findFirst({
        where: { id, userId },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Contact not found' });
      }

      await prisma.emergencyContact.deleteMany({
        where: { id, userId },
      });

      logger.info('Emergency contact deleted', { userId, contactId: id });
      return res.status(200).json({ success: true, message: 'Contact deleted successfully' });
    } catch (error: any) {
      logger.error('Error in deleteContact', { error: error.message });
      return res.status(500).json({ error: 'Failed to delete contact' });
    }
  }

  /**
   * PATCH /contacts/:id/confirm-consent
   * Confirms consent for a contact, opting them in
   */
  async confirmConsent(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const contact = await prisma.emergencyContact.updateMany({
        where: { id: req.params.id, userId },
        data: { consentStatus: 'OPTED_IN', consentAt: new Date(), optOutAt: null },
      });
      if (contact.count === 0) return res.status(404).json({ error: 'Contact not found' });
      const updated = await prisma.emergencyContact.findFirst({ where: { id: req.params.id, userId } });
      logger.info('Emergency contact opted in', { userId, contactId: req.params.id });
      return res.status(200).json(updated);
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to record contact consent' });
    }
  }

  /**
   * PATCH /contacts/:id/opt-out
   * Opts out a contact, updating their consent status
   */
  async optOut(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const contact = await prisma.emergencyContact.updateMany({
        where: { id: req.params.id, userId },
        data: { consentStatus: 'OPTED_OUT', optOutAt: new Date() },
      });
      if (contact.count === 0) return res.status(404).json({ error: 'Contact not found' });
      const updated = await prisma.emergencyContact.findFirst({ where: { id: req.params.id, userId } });
      logger.info('Emergency contact opted out', { userId, contactId: req.params.id });
      return res.status(200).json(updated);
    } catch (error: any) {
      return res.status(500).json({ error: 'Failed to opt out contact' });
    }
  }
}

export const contactsController = new ContactsController();
