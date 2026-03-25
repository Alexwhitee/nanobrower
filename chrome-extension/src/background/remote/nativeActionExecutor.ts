import type { RemoteNativeActionName } from '@extension/shared';
import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import { buildRemotePageState, parseRemoteElementId } from './pageState';

const logger = createLogger('RemoteNativeActionExecutor');

export async function executeNativeAction(
  browserContext: BrowserContext,
  action: RemoteNativeActionName,
  params: Record<string, unknown> | undefined,
  sessionId: string,
  lastActionResult: { action: 'native_action'; ok: boolean; message: string },
  screenshotRef: string | null,
): Promise<{
  native_action: RemoteNativeActionName;
  result: Record<string, unknown>;
  page_state?: ReturnType<typeof buildRemotePageState>;
}> {
  const page = await browserContext.getCurrentPage();
  const browserState = await browserContext.getState(false, true);
  const getFreshState = async () =>
    buildRemotePageState(await browserContext.getState(false, true), sessionId, lastActionResult, screenshotRef);

  switch (action) {
    case 'history.go_back': {
      await page.goBack();
      return {
        native_action: action,
        result: { message: 'Navigated back' },
        page_state: await getFreshState(),
      };
    }
    case 'history.go_forward': {
      await page.goForward();
      return {
        native_action: action,
        result: { message: 'Navigated forward' },
        page_state: await getFreshState(),
      };
    }
    case 'scroll.to_text': {
      const text = String(params?.text || '');
      const nth = Number(params?.nth ?? 1);
      if (!text) {
        throw new Error('scroll.to_text requires params.text');
      }
      const matched = await page.scrollToText(text, Number.isFinite(nth) ? nth : 1);
      return {
        native_action: action,
        result: {
          matched,
          message: matched ? `Scrolled to text "${text}"` : `Text "${text}" not found`,
        },
        page_state: await getFreshState(),
      };
    }
    case 'scroll.previous_page': {
      const elementId = typeof params?.element_id === 'string' ? params.element_id : '';
      const elementNode = elementId ? page.getDomElementByIndex(parseRemoteElementId(elementId)) : null;
      await page.scrollToPreviousPage(elementNode || undefined);
      return {
        native_action: action,
        result: { message: 'Scrolled to previous page' },
        page_state: await getFreshState(),
      };
    }
    case 'scroll.next_page': {
      const elementId = typeof params?.element_id === 'string' ? params.element_id : '';
      const elementNode = elementId ? page.getDomElementByIndex(parseRemoteElementId(elementId)) : null;
      await page.scrollToNextPage(elementNode || undefined);
      return {
        native_action: action,
        result: { message: 'Scrolled to next page' },
        page_state: await getFreshState(),
      };
    }
    case 'scroll.to_top':
    case 'scroll.to_bottom': {
      const elementId = typeof params?.element_id === 'string' ? params.element_id : '';
      const elementNode = elementId ? page.getDomElementByIndex(parseRemoteElementId(elementId)) : null;
      await page.scrollToPercent(action === 'scroll.to_top' ? 0 : 100, elementNode || undefined);
      return {
        native_action: action,
        result: { message: action === 'scroll.to_top' ? 'Scrolled to top' : 'Scrolled to bottom' },
        page_state: await getFreshState(),
      };
    }
    case 'dropdown.get_options': {
      const elementId = typeof params?.element_id === 'string' ? params.element_id : '';
      if (!elementId) {
        throw new Error('dropdown.get_options requires params.element_id');
      }
      const options = await page.getDropdownOptions(parseRemoteElementId(elementId));
      return {
        native_action: action,
        result: { options },
        page_state: await getFreshState(),
      };
    }
    case 'extract.visible_text': {
      const elementId = typeof params?.element_id === 'string' ? params.element_id : '';
      if (elementId) {
        const elementNode = page.getDomElementByIndex(parseRemoteElementId(elementId));
        if (!elementNode) {
          throw new Error(`Element not found for element_id=${elementId}`);
        }
        return {
          native_action: action,
          result: { text: elementNode.getAllTextTillNextClickableElement(3) },
          page_state: await getFreshState(),
        };
      }

      const pageState = buildRemotePageState(browserState, sessionId, lastActionResult, screenshotRef);
      return {
        native_action: action,
        result: { text: pageState.page_text_summary },
        page_state: pageState,
      };
    }
    case 'extract.readability': {
      try {
        const readability = await page.getReadabilityContent();
        return {
          native_action: action,
          result: readability as unknown as Record<string, unknown>,
          page_state: await getFreshState(),
        };
      } catch (error) {
        logger.error('Readability extraction failed', error);
        throw error;
      }
    }
    default:
      throw new Error(`Unsupported native action: ${action}`);
  }
}
