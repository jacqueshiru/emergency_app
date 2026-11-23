import {
  AuthTokensDTO,
  EmergencyContactDTO,
  CreateContactDTO,
  UpdateContactDTO,
  AlertDTO,
  CreateAlertDTO,
  DeviceDeliveryReportDTO,
  AuditLogDTO,
} from '@seas/shared';

import { getApiBase, getHostedApiBase } from './config';
import * as store from './tokenStore';
import { saveContacts } from './contactsCache';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public body?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AdminUserDTO {
  id: string;
  phoneNumber: string;
  name: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
  contactsCount: number;
  alertsCount: number;
}

class ApiService {
  private getAccessToken(): string | null {
    return store.getItem('seas_access_token');
  }

  private getRefreshToken(): string | null {
    return store.getItem('seas_refresh_token');
  }

  private setTokens(access: string, refresh?: string) {
    store.setItem('seas_access_token', access);
    if (refresh) {
      store.setItem('seas_refresh_token', refresh);
    }
  }

  private clearTokens() {
    store.removeItem('seas_access_token');
    store.removeItem('seas_refresh_token');
    store.removeItem('seas_user');
    store.removeItem('seas_contacts');
  }

  // ---- Session refresh (single-flight) ----
  private refreshInFlight: Promise<string> | null = null;

  /** Reads the `exp` claim (seconds) from a JWT without verifying it. Null if unreadable. */
  private tokenExpiryMs(token: string): number | null {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  private isExpired(token: string, skewMs = 5000): boolean {
    const exp = this.tokenExpiryMs(token);
    return exp !== null && exp - skewMs <= Date.now();
  }

  private forceLogout(): never {
    this.clearTokens();
    if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    throw new ApiError('Session expired', 401, 'SESSION_EXPIRED');
  }

  /**
   * All concurrent callers share ONE /auth/refresh call. On failure everyone is logged out.
   * A network failure (offline) is NOT treated as an invalid session: tokens are kept.
   */
  private refreshAccessToken(): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) this.forceLogout();

    this.refreshInFlight = (async () => {
      let res: Response;
      try {
        res = await fetch(`${getApiBase()}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        throw new ApiError('Offline', 0, 'OFFLINE');
      }
      // Only a definitive rejection of the refresh token ends the session. A 429 / 5xx / proxy error
      // is transient: logging out there would also wipe the on-phone contact copy the offline SOS needs.
      if (res.status === 400 || res.status === 401 || res.status === 403) this.forceLogout();
      if (!res.ok) throw new ApiError('Could not refresh the session right now', res.status, 'REFRESH_UNAVAILABLE');
      const data = await res.json();
      this.setTokens(data.accessToken, data.refreshToken);
      return data.accessToken as string;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  /** Call on app load: refresh up front if the stored access token is already expired. */
  async ensureFreshSession(): Promise<void> {
    const token = this.getAccessToken();
    if (token && this.isExpired(token)) {
      await this.refreshAccessToken();
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    base = getApiBase(),
    refreshSession = true
  ): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${base}${endpoint}`;
    const isAuthEndpoint = endpoint.includes('/auth/');

    // Proactive refresh avoids a guaranteed 401 round-trip.
    let token = this.getAccessToken();
    if (refreshSession && token && !isAuthEndpoint && this.isExpired(token) && this.getRefreshToken()) {
      token = await this.refreshAccessToken();
    }

    const send = (t: string | null) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...((options.headers as Record<string, string>) || {}),
      };
      if (t) headers['Authorization'] = `Bearer ${t}`;
      return fetch(url, { ...options, headers });
    };

    let response: Response;
    try {
      response = await send(token);
    } catch {
      throw new ApiError(
        navigator.onLine
          ? 'Cannot reach the server. Check your connection, and the server address under "Server settings" on the login screen.'
          : 'Offline',
        0,
        'OFFLINE'
      );
    }

    if (refreshSession && response.status === 401 && !isAuthEndpoint) {
      const newToken = await this.refreshAccessToken();
      try {
        response = await send(newToken);
      } catch {
        throw new ApiError('Network error. Please check your connection.', 0, 'OFFLINE');
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new ApiError(
        errorData.error || errorData.message || `Request failed with code ${response.status}`,
        response.status,
        errorData.code,
        errorData
      );
    }

    return response.json();
  }

  // Auth API
  async requestOtp(phoneNumber: string, name?: string): Promise<{ success: boolean; devCode?: string }> {
    return this.request('/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, name }),
    });
  }

  async verifyOtp(phoneNumber: string, code: string, name?: string): Promise<AuthTokensDTO> {
    const data = await this.request<AuthTokensDTO>('/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, code, name }),
    });
    this.setTokens(data.accessToken, data.refreshToken);
    store.setItem('seas_user', JSON.stringify(data.user));
    return data;
  }

  async logout(): Promise<void> {
    const refreshToken = this.getRefreshToken();
    if (refreshToken) {
      await this.request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    }
    this.clearTokens();
  }

  // Contacts API
  async getContacts(): Promise<EmergencyContactDTO[]> {
    const list = await this.request<EmergencyContactDTO[]>('/contacts');
    saveContacts(list); // keep an on-phone copy so the SOS can text contacts with no internet
    return list;
  }

  /** Re-fetches contacts after a change so the on-phone copy never goes stale. Best effort. */
  private refreshContactsCache() {
    void this.getContacts().catch(() => {});
  }

  async createContact(contact: CreateContactDTO): Promise<EmergencyContactDTO> {
    const created = await this.request<EmergencyContactDTO>('/contacts', {
      method: 'POST',
      body: JSON.stringify(contact),
    });
    this.refreshContactsCache();
    return created;
  }

  async updateContact(id: string, contact: UpdateContactDTO): Promise<EmergencyContactDTO> {
    const updated = await this.request<EmergencyContactDTO>(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(contact),
    });
    this.refreshContactsCache();
    return updated;
  }

  async deleteContact(id: string): Promise<void> {
    await this.request(`/contacts/${id}`, { method: 'DELETE' });
    this.refreshContactsCache();
  }

  // Alerts API
  async createAlert(alertData: CreateAlertDTO): Promise<AlertDTO> {
    return this.request<AlertDTO>('/alerts', {
      method: 'POST',
      body: JSON.stringify(alertData),
    });
  }

  /** Phone-sent alerts: report later carrier delivery results for contacts the phone texted. */
  async reportDeviceDeliveries(alertId: string, reports: DeviceDeliveryReportDTO[], deviceProofNonce?: string | null): Promise<{ updated: number }> {
    return this.request<{ updated: number }>(`/alerts/${alertId}/device-reports`, {
      method: 'POST',
      body: JSON.stringify({ reports, deviceProofNonce }),
    });
  }

  async getMyAlerts(): Promise<AlertDTO[]> {
    return this.request<AlertDTO[]>('/alerts');
  }

  async getAlertById(id: string): Promise<AlertDTO> {
    return this.request<AlertDTO>(`/alerts/${id}`);
  }

  async resolveAlert(id: string): Promise<AlertDTO> {
    return this.request<AlertDTO>(`/alerts/${id}/resolve`, {
      method: 'PATCH',
    });
  }

  async cancelAlert(id: string): Promise<AlertDTO> {
    return this.request<AlertDTO>(`/alerts/${id}/cancel`, {
      method: 'PATCH',
    });
  }

  // Admin API
  async getAdminAlerts(filters?: { status?: string; resolutionStatus?: string; from?: string; to?: string }): Promise<AlertDTO[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.resolutionStatus) params.append('resolutionStatus', filters.resolutionStatus);
    if (filters?.from) params.append('from', filters.from);
    if (filters?.to) params.append('to', filters.to);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<AlertDTO[]>(`/admin/alerts${query}`);
  }

  async getHostedAdminAlerts(filters?: { status?: string; resolutionStatus?: string; from?: string; to?: string }): Promise<AlertDTO[]> {
    const params = new URLSearchParams();
    if (filters?.status) params.append('status', filters.status);
    if (filters?.resolutionStatus) params.append('resolutionStatus', filters.resolutionStatus);
    if (filters?.from) params.append('from', filters.from);
    if (filters?.to) params.append('to', filters.to);

    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<AlertDTO[]>(`/admin/alerts${query}`, {}, getHostedApiBase(), false);
  }

  async getAdminUsers(): Promise<AdminUserDTO[]> {
    return this.request('/admin/users');
  }

  async getHostedAdminUsers(): Promise<AdminUserDTO[]> {
    return this.request('/admin/users', {}, getHostedApiBase(), false);
  }

  async getAdminAuditLogs(): Promise<AuditLogDTO[]> {
    return this.request('/admin/audit-logs');
  }

  async getHostedAdminAuditLogs(): Promise<AuditLogDTO[]> {
    return this.request('/admin/audit-logs', {}, getHostedApiBase(), false);
  }

  async confirmContactConsent(id: string): Promise<EmergencyContactDTO> {
    return this.request(`/contacts/${id}/consent/confirm`, { method: 'POST' });
  }

  async optOutContact(id: string): Promise<EmergencyContactDTO> {
    return this.request(`/contacts/${id}/opt-out`, { method: 'POST' });
  }

  async exportMyData(): Promise<void> {
    const token = this.getAccessToken();
    const response = await fetch(`${getApiBase()}/auth/me/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new ApiError('Could not export account data', response.status);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'seas-data-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async deleteMyAccount(): Promise<void> {
    await this.request('/auth/me', {
      method: 'DELETE',
      body: JSON.stringify({ confirmation: 'DELETE' }),
    });
    this.clearTokens();
  }

  async setupAdminMfa(): Promise<{ secret: string; otpauth: string }> {
    return this.request('/auth/admin/mfa/setup', { method: 'POST' });
  }

  async verifyAdminMfa(code: string): Promise<{ success: boolean; accessToken: string }> {
    const data = await this.request<{ success: boolean; accessToken: string }>('/auth/admin/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    this.setTokens(data.accessToken);
    return data;
  }
}

export const api = new ApiService();
