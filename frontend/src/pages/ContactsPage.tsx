import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { EmergencyContactDTO } from '@seas/shared';
import { Users, Plus, Trash2, Edit2, AlertCircle, Phone, User as UserIcon, HeartHandshake } from 'lucide-react';
import { smsSender, smsSenderSupported } from '../services/smsSender';

export const ContactsPage: React.FC = () => {
  const [contacts, setContacts] = useState<EmergencyContactDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [relationship, setRelationship] = useState('Family');
  const [saving, setSaving] = useState(false);

  // Tier state
  const [tier, setTier] = useState<'CRITICAL' | 'EVERYDAY'>('EVERYDAY');
  const [tierFilter, setTierFilter] = useState<'ALL' | 'CRITICAL' | 'EVERYDAY'>('ALL');

  const fetchContacts = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getContacts();
      setContacts(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
  }, []);

  const resetForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setName('');
    setPhoneNumber('');
    setRelationship('Family');
    setTier('EVERYDAY');
    setError(null);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !phoneNumber.trim()) {
      setError('Name and phone number are required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (editingId) {
        await api.updateContact(editingId, {
          name: name.trim(),
          phoneNumber: phoneNumber.trim(),
          relationship,
          tier,
        });
      } else {
        await api.createContact({
          name: name.trim(),
          phoneNumber: phoneNumber.trim(),
          relationship,
          tier,
        });
      }
      resetForm();
      fetchContacts();
    } catch (err: any) {
      setError(err.message || 'Failed to save contact');
    } finally {
      setSaving(false);
    }
  };

  const handleStartEdit = (contact: EmergencyContactDTO) => {
    setEditingId(contact.id);
    setName(contact.name);
    setPhoneNumber(contact.phoneNumber);
    setRelationship(contact.relationship || 'Family');
    setTier(contact.tier === 'CRITICAL' ? 'CRITICAL' : 'EVERYDAY');
    setIsAdding(true);
  };

  const handleDelete = async (id: string, contactName: string) => {
    if (!window.confirm(`Are you sure you want to remove ${contactName} from your emergency contacts?`)) {
      return;
    }

    try {
      await api.deleteContact(id);
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch (err: any) {
      setError(err.message || 'Failed to delete contact');
    }
  };

  const handleConfirmConsent = async (id: string) => {
    try {
      const updated = await api.confirmContactConsent(id);
      setContacts((prev) => prev.map((contact) => contact.id === id ? updated : contact));
    } catch (err: any) { setError(err.message || 'Failed to confirm consent'); }
  };

  const handleOptOut = async (id: string) => {
    if (!window.confirm('Stop this contact from receiving future SOS alerts?')) return;
    try {
      const updated = await api.optOutContact(id);
      setContacts((prev) => prev.map((contact) => contact.id === id ? updated : contact));
    } catch (err: any) { setError(err.message || 'Failed to opt out'); }
  };

  const handlePickContact = async () => {
    if (!smsSenderSupported) {
      setError('Phone contact selection is available in the Android app.');
      return;
    }
    try {
      const picked = await smsSender.pickContact();
      if (picked.name) setName(picked.name);
      if (picked.phoneNumber) setPhoneNumber(picked.phoneNumber);
      setError(null);
    } catch (err: any) {
      if (err?.message !== 'No contact selected') setError(err?.message || 'Could not open phone contacts');
    }
  };

  // Filtered contacts based on tier
  const filteredContacts = tierFilter === 'ALL' ? contacts : contacts.filter(contact => contact.tier === tierFilter);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center space-x-2">
            <Users className="w-6 h-6 text-red-500" />
            <span>Emergency Contacts</span>
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            People who will immediately receive SMS alerts and your location coordinates when you trigger an SOS.
          </p>
        </div>

        {!isAdding && (
          <button
            onClick={() => {
              resetForm();
              setIsAdding(true);
            }}
            className="flex items-center space-x-2 bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-xl text-sm font-medium transition shadow-lg shadow-red-950/40"
          >
            <Plus className="w-4 h-4" />
            <span>Add Contact</span>
          </button>
        )}
      </div>

      {contacts.length === 0 && !loading && !isAdding && (
        <div className="p-6 rounded-2xl bg-amber-950/30 border border-amber-800/50 text-amber-200 mb-6 flex items-start space-x-4">
          <AlertCircle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-base font-semibold">No emergency contacts configured!</h2>
            <p className="text-sm text-amber-300/80 mt-1">
              The system requires at least one verified emergency contact. You will not be able to trigger an SOS alert until you add a contact.
            </p>
            <button
              onClick={() => setIsAdding(true)}
              className="mt-3 bg-amber-600 hover:bg-amber-500 text-black px-4 py-1.5 rounded-lg text-xs font-semibold"
            >
              Add First Contact Now
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-950/60 border border-red-800 text-red-200 text-sm">
          {error}
        </div>
      )}

      {isAdding && (
        <div className="mb-8 p-6 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-xl">
          <h2 className="text-lg font-semibold text-white mb-4">
            {editingId ? 'Edit Emergency Contact' : 'Add Emergency Contact'}
          </h2>
          <form onSubmit={handleSaveContact} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Full Name</label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                  <input
                    type="text"
                    placeholder="e.g. Mary Wanjiku"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">Phone Number</label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                  <input
                    type="tel"
                    placeholder="0712 345 678 or +254..."
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-600 outline-none"
                    required
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Relationship</label>
              <div className="relative">
                <HeartHandshake className="w-4 h-4 text-zinc-500 absolute left-3 top-3.5" />
                <select
                  value={relationship}
                  onChange={(e) => setRelationship(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-red-500 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white outline-none"
                >
                  <option value="Family">Family / Parent / Sibling</option>
                  <option value="Spouse">Spouse / Partner</option>
                  <option value="Friend">Close Friend</option>
                  <option value="Neighbor">Neighbor</option>
                  <option value="Colleague">Colleague</option>
                  <option value="Doctor">Doctor / Caregiver</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5">Notification Type</label>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as 'CRITICAL' | 'EVERYDAY')}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-white outline-none"
              >
                <option value="EVERYDAY">Everyday — landing-page SOS only</option>
                <option value="CRITICAL">Critical — volume shortcut also</option>
              </select>
            </div>

            <div className="flex justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 rounded-xl text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white px-5 py-2 rounded-xl text-sm font-medium transition"
              >
                {saving ? 'Saving...' : editingId ? 'Update Contact' : 'Save Contact'}
              </button>
            </div>
          </form>

          <button
            type="button"
            onClick={() => void handlePickContact()}
            className="mt-2 text-xs font-medium text-red-400 hover:text-red-300"
          >
            Select from phone contacts
          </button>
        </div>
      )}

      <div className="mb-6 p-4 rounded-2xl bg-zinc-800 border border-zinc-700">
        <h2 className="text-sm font-semibold text-white mb-3">Contact Tiers</h2>
        <div className="flex space-x-2">
          <button
            onClick={() => setTierFilter('ALL')}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center space-x-2
            ${tierFilter === 'ALL' ? 'bg-red-600 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}
            `}
          >
            <span>All Contacts</span>
          </button>
          <button
            onClick={() => setTierFilter('CRITICAL')}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center space-x-2
            ${tierFilter === 'CRITICAL' ? 'bg-red-600 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}
            `}
          >
            <span>Critical Contacts</span>
          </button>
          <button
            onClick={() => setTierFilter('EVERYDAY')}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center justify-center space-x-2
            ${tierFilter === 'EVERYDAY' ? 'bg-red-600 text-white' : 'bg-zinc-700 text-zinc-200 hover:bg-zinc-600'}
            `}
          >
            <span>Everyday Contacts</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-zinc-500 text-sm">Loading contacts...</div>
      ) : (
        <div className="space-y-3">
          {filteredContacts.map((contact) => (
            <div
              key={contact.id}
              className="bg-zinc-900 border border-zinc-800/80 rounded-2xl p-4 flex items-center justify-between hover:border-zinc-700 transition"
            >
              <div className="flex items-center space-x-3.5">
                <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center font-bold text-zinc-300">
                  {contact.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="font-semibold text-white text-base leading-tight">{contact.name}</h3>
                  <div className="flex items-center space-x-2 text-xs text-zinc-400 mt-1">
                    <span className="font-mono">{contact.phoneNumber}</span>
                    {contact.relationship && (
                      <>
                        <span>•</span>
                        <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[11px]">
                          {contact.relationship}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center space-x-1">
                {contact.consentStatus !== 'OPTED_IN' && (
                  <button
                    onClick={() => handleConfirmConsent(contact.id)}
                    className="px-2 py-1 text-xs text-emerald-300 border border-emerald-800 rounded-lg hover:bg-emerald-950"
                  >
                    Confirm consent
                  </button>
                )}
                {contact.consentStatus === 'OPTED_IN' && (
                  <button
                    onClick={() => handleOptOut(contact.id)}
                    className="px-2 py-1 text-xs text-amber-300 border border-amber-800 rounded-lg hover:bg-amber-950"
                  >
                    Opt out
                  </button>
                )}
                <button
                  onClick={() => handleStartEdit(contact)}
                  className="p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition"
                  title="Edit contact"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(contact.id, contact.name)}
                  className="p-2 text-zinc-400 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition"
                  title="Delete contact"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
