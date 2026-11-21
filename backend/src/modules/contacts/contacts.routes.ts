import { Router } from 'express';
import { contactsController } from './contacts.controller';
import { authenticate } from '../../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', (req, res) => contactsController.getContacts(req, res));
router.post('/', (req, res) => contactsController.createContact(req, res));
router.patch('/:id', (req, res) => contactsController.updateContact(req, res));
router.delete('/:id', (req, res) => contactsController.deleteContact(req, res));
router.post('/:id/consent/confirm', (req, res) => contactsController.confirmConsent(req, res));
router.post('/:id/opt-out', (req, res) => contactsController.optOut(req, res));

export const contactsRoutes = router;
